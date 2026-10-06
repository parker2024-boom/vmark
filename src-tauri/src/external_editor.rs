//! # External Editor
//!
//! Purpose: Launch the user's `$EDITOR` (or platform default) on a file
//! path. Backs the "Open in external editor" button surfaced
//! inside the read-only code viewer.
//!
//! Pipeline: frontend `invoke("open_in_external_editor", { path,
//! editorOverride })` → `spawn_blocking` (path checks + spawn stay off the
//! main thread) → validate the override (`override_guard`) → resolve editor
//! command via the override → `$VMARK_EXTERNAL_EDITOR` → `$VISUAL` →
//! `$EDITOR` → platform default → spawn detached → return.
//!
//! Key decisions:
//!   - macOS GUI apps inherit a minimal PATH from launchd, so we go
//!     through `ai_provider::login_shell_path()` (already used for
//!     Codex / Claude CLI launch) so VS Code, Cursor, JetBrains
//!     wrappers, etc. resolve.
//!   - The override is webview-supplied, so it may only name an editor:
//!     a known editor name or an existing path that is not an interpreter
//!     or a shell (`override_guard.rs`). The env vars are not
//!     webview-supplied and are not restricted.
//!   - Spawned through `ai_provider::build_command()`, so a Windows `.cmd`
//!     launcher (`code.cmd`) gets the file path as an escaped argument.
//!   - Spawn detached: we don't wait for the editor to exit. The
//!     Tauri command returns as soon as the child is launched.
//!   - Best-effort: spawn failures return a `Result::Err` with a
//!     human-readable message. The frontend toasts it.
//!
//! Known limitations:
//!   - Env-var editor commands ($VMARK_EXTERNAL_EDITOR / $VISUAL / $EDITOR)
//!     are split on whitespace with no quoting support, so ANY executable
//!     path containing a space breaks — e.g. `EDITOR="/Applications/Sublime
//!     Text.app/…/bin/subl"` splits at "Sublime". Use the GUI editor
//!     override (a single absolute path, never split) or a wrapper script.

use crate::ai_provider::{build_command, login_shell_path};
use override_guard::validate_editor_override;
use std::path::Path;

mod override_guard;
mod program_names;

/// Resolve which editor command to launch. Order:
///   1. `editor_override` from the GUI setting (explicit beats implicit;
///      already validated by `validate_editor_override`)
///   2. `$VMARK_EXTERNAL_EDITOR` (project override)
///   3. `$VISUAL`
///   4. `$EDITOR`
///   5. Platform default (`open -t` on macOS, `notepad.exe` on Windows,
///      `xdg-open` on Linux/BSD)
fn resolve_editor(editor_override: Option<&str>) -> String {
    if let Some(v) = editor_override {
        if !v.trim().is_empty() {
            return v.to_string();
        }
    }
    if let Ok(v) = std::env::var("VMARK_EXTERNAL_EDITOR") {
        if !v.trim().is_empty() {
            return v;
        }
    }
    if let Ok(v) = std::env::var("VISUAL") {
        if !v.trim().is_empty() {
            return v;
        }
    }
    if let Ok(v) = std::env::var("EDITOR") {
        if !v.trim().is_empty() {
            return v;
        }
    }
    // Platform default fallback.
    #[cfg(target_os = "macos")]
    {
        "open -t".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "notepad.exe".to_string()
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        "xdg-open".to_string()
    }
}

/// macOS-only: when the resolved executable is an `.app` bundle directory,
/// rewrite the spawn arguments to `open -a <bundle> <file>` so Launch
/// Services routes the open through the bundle's main executable. Without
/// this, `Command::new("/Applications/Cursor.app").spawn()` fails because
/// `.app` is a directory, not an executable.
///
/// Returns `Some((exe, args))` if a rewrite happened; `None` to use the
/// caller's exe + args unchanged.
#[cfg(target_os = "macos")]
fn maybe_open_app_bundle(
    exe: &str,
    extra_args: &[&str],
    file_path: &str,
) -> Option<(String, Vec<String>)> {
    let p = Path::new(exe);
    if exe.ends_with(".app") && p.is_dir() {
        let mut args = vec!["-a".to_string(), exe.to_string()];
        args.extend(extra_args.iter().map(|a| a.to_string()));
        args.push(file_path.to_string());
        Some(("open".to_string(), args))
    } else {
        None
    }
}

/// Open `path` in the user's external editor. Returns `Ok(())` once
/// the child has been spawned (we do NOT wait). On spawn failure,
/// returns a human-readable error so the frontend can toast it.
///
/// `async` + `spawn_blocking` because the body does filesystem checks and
/// spawns a subprocess (plus a possible `$SHELL -lic` PATH probe on the
/// first `login_shell_path()` call) — a sync command would run all of that
/// on the main thread and beachball the UI.
#[tauri::command]
pub async fn open_in_external_editor(
    path: String,
    editor_override: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_in_external_editor_blocking(path, editor_override))
        .await
        .map_err(|e| format!("external editor task failed: {e}"))?
}

/// Blocking body of `open_in_external_editor` (runs on the blocking thread
/// pool).
///
/// Accepts only paths that:
///   1. Resolve to a regular file (not a directory or device).
///   2. Have a registered VMark format extension (mirrors the
///      `validate_openable_path` security gate so a compromised
///      webview can't aim the external editor at arbitrary targets).
///
/// Canonicalization runs first so symlinks resolve before the
/// extension check (a `.md` link to `/etc/passwd` is rejected).
fn open_in_external_editor_blocking(
    path: String,
    editor_override: Option<String>,
) -> Result<(), String> {
    let canonical = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("invalid path '{path}': {e}"))?;
    if !canonical.is_file() {
        return Err(format!("path '{path}' is not a regular file"));
    }
    if !crate::is_openable_supported(&canonical) {
        return Err(format!("path '{path}' is not an openable VMark file"));
    }

    // Validate the GUI override BEFORE feeding it into the resolution
    // chain. The webview supplies it, and `path` above can be a script
    // (`.sh`, `.py`, `.rb`, `.js` are openable), so an override naming an
    // interpreter would run the file instead of opening it: only a known
    // editor name or an existing non-interpreter path gets through.
    let validated_override = match editor_override.as_deref() {
        Some(raw) => Some(validate_editor_override(raw)?),
        None => None,
    };
    let editor_cmd = resolve_editor(validated_override.as_deref());
    // GUI override: treat the entire string as a single exe (path or
    // bare command — already validated to have no internal whitespace
    // unless it's an existing absolute path like `/Applications/My
    // App.app`). Env-var / platform-default values still allow args
    // via whitespace because they aren't webview-supplied.
    let (exe, extra_args): (&str, Vec<&str>) =
        if validated_override.as_deref().is_some_and(|s| !s.is_empty()) {
            (editor_cmd.as_str(), Vec::new())
        } else {
            let mut parts = editor_cmd.split_whitespace();
            let first = parts.next().unwrap_or("");
            let rest: Vec<&str> = parts.collect();
            (first, rest)
        };
    if exe.is_empty() {
        return Err("No editor configured (EDITOR / VISUAL unset)".to_string());
    }

    // macOS .app bundle support: a path like `/Applications/Cursor.app`
    // isn't executable directly. Rewrite to `open -a <bundle> <file>`
    // so Launch Services dispatches to the bundle's main executable.
    #[cfg(target_os = "macos")]
    let (exe_owned, args_owned): (String, Vec<String>) =
        match maybe_open_app_bundle(exe, &extra_args, &path) {
            Some((e, a)) => (e, a),
            None => {
                let mut a: Vec<String> = extra_args.iter().map(|s| s.to_string()).collect();
                a.push(path.clone());
                (exe.to_string(), a)
            }
        };
    #[cfg(not(target_os = "macos"))]
    let (exe_owned, args_owned): (String, Vec<String>) = {
        let mut a: Vec<String> = extra_args.iter().map(|s| s.to_string()).collect();
        a.push(path.clone());
        (exe.to_string(), a)
    };

    let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
    let mut cmd = build_command(&exe_owned, &args_refs);
    cmd.env("PATH", login_shell_path());
    match cmd.spawn() {
        Ok(child) => {
            // Reap on a detached thread so fast-exiting launchers
            // (`open -t`, `xdg-open`) don't leave zombies on Unix.
            // We deliberately don't wait synchronously — the editor
            // may run for hours. spawn_thread_logged surfaces the
            // (extremely unlikely) panic via the structured log channel.
            let mut child = child;
            crate::task::spawn_thread_logged("external-editor-reaper", move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => Err(format!(
            "Failed to launch editor '{exe_owned}' for '{path}': {e}"
        )),
    }
}

#[cfg(test)]
#[path = "external_editor.test.rs"]
mod tests;
