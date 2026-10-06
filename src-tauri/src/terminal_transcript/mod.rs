//! Exact terminal-to-transcript bindings, delivered by CLI SessionStart hooks.
//! Reads are bounded, canonical-root confined, and never touch PTY output; a
//! poll that carries the cursor of the previous one gets only what was
//! appended since (`follow.rs`).
use crate::command_error::CommandError;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, State};
mod config;
mod follow;
mod open;
use config::add_hook;
pub use follow::{TranscriptCursor, TranscriptDelta};
#[cfg(test)]
mod tests;
/// Serializes CLI config writes; a newer request supersedes queued older ones.
#[derive(Default)]
pub struct TranscriptConfigState(Arc<ConfigGate>);
#[derive(Default)]
struct ConfigGate {
    lock: Mutex<()>,
    revision: AtomicU64,
}
/// The most transcript a fresh tail carries, and the most a poll may fall behind
/// before it is answered with a fresh tail instead of a delta.
const LIMIT: u64 = 2 * 1024 * 1024;
/// A token is the lowercase hyphenated UUID `terminal_transcript_prepare`
/// issues, and nothing else. It names the binding file, so the other spellings
/// of the same UUID (uppercase, braced, `urn:uuid:`, no hyphens) would each
/// name a different file.
fn valid_token(token: &str) -> bool {
    uuid::Uuid::parse_str(token).is_ok_and(|uuid| uuid.as_hyphenated().to_string() == token)
}
fn directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CommandError> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("terminal-transcripts"))
        .map_err(|e| CommandError::io(e.to_string()))
}
/// Allocate an opaque binding for this shell, even if preview is currently off.
#[tauri::command]
pub fn terminal_transcript_prepare() -> String {
    uuid::Uuid::new_v4().to_string()
}
/// Install additive CLI hooks, or deactivate installed hooks without deleting user config.
#[tauri::command]
pub async fn terminal_transcript_configure<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TranscriptConfigState>,
    enabled: bool,
) -> Result<(), CommandError> {
    let root = directory(&app)?;
    let gate = Arc::clone(&state.0);
    let generation = gate.revision.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate
            .lock
            .lock()
            .map_err(|e| CommandError::internal(e.to_string()))?;
        if generation != gate.revision.load(Ordering::SeqCst) {
            return Ok(());
        }
        let (claude, codex) = cli_roots()?;
        configure(&root, enabled, &claude, &codex)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}
fn configure(root: &Path, enabled: bool, claude: &Path, codex: &Path) -> Result<(), CommandError> {
    std::fs::create_dir_all(root).map_err(|e| CommandError::io(e.to_string()))?;
    let marker = root.join("enabled");
    if !enabled {
        if marker.exists() {
            std::fs::remove_file(marker).map_err(|e| CommandError::io(e.to_string()))?;
        }
        return prune_bindings(root);
    }
    let script = root.join("terminal-transcript-hook.cjs");
    std::fs::write(
        &script,
        include_str!("../../resources/terminal-transcript-hook.cjs"),
    )
    .map_err(|e| CommandError::io(e.to_string()))?;
    let command = if cfg!(windows) {
        format!("node \"{}\"", script.display())
    } else {
        format!("node '{}'", script.to_string_lossy().replace('\'', "'\\''"))
    };
    // Resolve, parse and validate BOTH before writing either, so a malformed
    // config — or one whose symlink leads nowhere — leaves both untouched.
    let paths = [claude.join("settings.json"), codex.join("hooks.json")];
    let mut configs = Vec::new();
    for path in &paths {
        let target = config::resolve_target(path)?;
        let mut value: Value = if target.exists() {
            serde_json::from_slice(
                &std::fs::read(&target).map_err(|e| CommandError::io(e.to_string()))?,
            )
            .map_err(|e| CommandError::invalid_input(e.to_string()))?
        } else {
            json!({})
        };
        if add_hook(&mut value, &command)? {
            configs.push((target, value));
        }
    }
    for (target, value) in configs {
        config::write_atomic(
            &target,
            &serde_json::to_vec_pretty(&value)
                .map_err(|e| CommandError::internal(e.to_string()))?,
        )?;
    }
    std::fs::write(marker, b"enabled").map_err(|e| CommandError::io(e.to_string()))?;
    Ok(())
}
/// The Claude and Codex config roots, honouring their override variables.
fn cli_roots() -> Result<(PathBuf, PathBuf), CommandError> {
    let home =
        dirs::home_dir().ok_or_else(|| CommandError::not_found("Home directory unavailable"))?;
    Ok((
        config_root("CLAUDE_CONFIG_DIR", home.join(".claude")),
        config_root("CODEX_HOME", home.join(".codex")),
    ))
}
fn config_root(key: &str, fallback: PathBuf) -> PathBuf {
    std::env::var_os(key)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or(fallback)
}
/// A missing binding is a normal waiting state. Caller supplies no filesystem path.
/// `cursor` is the one the previous answer carried; with it the answer holds only
/// the records appended since, without it (or when it no longer fits the file) a
/// fresh tail.
#[tauri::command]
pub async fn terminal_transcript_read<R: Runtime>(
    app: AppHandle<R>,
    token: String,
    cursor: Option<TranscriptCursor>,
) -> Result<Option<TranscriptDelta>, CommandError> {
    if !valid_token(&token) {
        return Err(CommandError::invalid_input("Invalid transcript token"));
    }
    let root = directory(&app)?;
    let (claude, codex) = cli_roots()?;
    let roots = [claude.join("projects"), codex.join("sessions")];
    tauri::async_runtime::spawn_blocking(move || {
        read_snapshot(&root, &roots, &token, cursor.as_ref())
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}
/// Delete a shell's binding when its session closes or its shell is replaced.
#[tauri::command]
pub async fn terminal_transcript_forget<R: Runtime>(
    app: AppHandle<R>,
    token: String,
) -> Result<(), CommandError> {
    if !valid_token(&token) {
        return Err(CommandError::invalid_input("Invalid transcript token"));
    }
    let root = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove_binding(&root, &token))
        .await
        .map_err(|e| CommandError::internal(e.to_string()))?
}
fn remove_binding(root: &Path, token: &str) -> Result<(), CommandError> {
    match std::fs::remove_file(root.join(format!("{token}.json"))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(CommandError::io(e.to_string())),
        _ => Ok(()),
    }
}
/// Disabling drops every binding; enabled shells re-bind on their next CLI start.
fn prune_bindings(root: &Path) -> Result<(), CommandError> {
    let entries = std::fs::read_dir(root).map_err(|e| CommandError::io(e.to_string()))?;
    for entry in entries {
        let path = entry.map_err(|e| CommandError::io(e.to_string()))?.path();
        let is_binding = path.extension().is_some_and(|ext| ext == "json")
            && path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(valid_token);
        if is_binding {
            std::fs::remove_file(&path).map_err(|e| CommandError::io(e.to_string()))?;
        }
    }
    Ok(())
}
fn allowed_path(path: &Path, roots: &[PathBuf]) -> bool {
    path.extension().is_some_and(|ext| ext == "jsonl")
        && roots
            .iter()
            .any(|root| root.canonicalize().is_ok_and(|root| path.starts_with(root)))
}
fn read_snapshot(
    root: &Path,
    roots: &[PathBuf],
    token: &str,
    previous: Option<&TranscriptCursor>,
) -> Result<Option<TranscriptDelta>, CommandError> {
    if !root.join("enabled").exists() {
        return Ok(None);
    }
    let binding = root.join(format!("{token}.json"));
    let bytes = match std::fs::read(&binding) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CommandError::io(e.to_string())),
    };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| CommandError::invalid_input(e.to_string()))?;
    let path = value["path"]
        .as_str()
        .ok_or_else(|| CommandError::invalid_input("Missing transcript path"))?;
    // The CLI announces its transcript before writing it: absent is still waiting.
    let path = match Path::new(path).canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CommandError::io(e.to_string())),
    };
    if !allowed_path(&path, roots) {
        return Err(CommandError::permission_denied(
            "Transcript outside CLI session directories",
        ));
    }
    follow::follow(&path, &value["sessionId"], previous, LIMIT)
}
