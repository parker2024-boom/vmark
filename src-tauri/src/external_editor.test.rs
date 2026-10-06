//! Tests for `external_editor.rs` (moved from the inline `#[cfg(test)]` module;
//! included via `#[path]`).

use super::*;
use std::sync::Mutex;

/// Serializes tests that mutate the process environment. `cargo test`
/// runs `#[test]` functions in parallel threads, but `std::env` is
/// process-wide — without this guard the three `resolve_editor_*`
/// tests below race on `VMARK_EXTERNAL_EDITOR` / `VISUAL` / `EDITOR`,
/// producing platform-dependent flaky failures (notably on Linux CI).
/// Holding `_guard` for the duration of each test makes the env
/// mutations effectively atomic across the suite.
static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn resolve_editor_prefers_gui_override_above_all() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // GUI setting beats every env var.
    let _vmark = std::env::var("VMARK_EXTERNAL_EDITOR").ok();
    let _visual = std::env::var("VISUAL").ok();
    let _editor = std::env::var("EDITOR").ok();
    std::env::set_var("VMARK_EXTERNAL_EDITOR", "vmark-env");
    std::env::set_var("VISUAL", "visual-env");
    std::env::set_var("EDITOR", "editor-env");
    assert_eq!(
        resolve_editor(Some("/Applications/Cursor.app")),
        "/Applications/Cursor.app"
    );
    // Empty / whitespace override falls through to env var chain.
    assert_eq!(resolve_editor(Some("")), "vmark-env");
    assert_eq!(resolve_editor(Some("   ")), "vmark-env");
    std::env::remove_var("VMARK_EXTERNAL_EDITOR");
    std::env::remove_var("VISUAL");
    std::env::remove_var("EDITOR");
    if let Some(v) = _vmark {
        std::env::set_var("VMARK_EXTERNAL_EDITOR", v);
    }
    if let Some(v) = _visual {
        std::env::set_var("VISUAL", v);
    }
    if let Some(v) = _editor {
        std::env::set_var("EDITOR", v);
    }
}

#[test]
fn resolve_editor_prefers_vmark_env_when_no_override() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _vmark = std::env::var("VMARK_EXTERNAL_EDITOR").ok();
    let _visual = std::env::var("VISUAL").ok();
    let _editor = std::env::var("EDITOR").ok();
    std::env::set_var("VMARK_EXTERNAL_EDITOR", "myeditor");
    std::env::set_var("VISUAL", "should-be-ignored");
    std::env::set_var("EDITOR", "should-be-ignored");
    assert_eq!(resolve_editor(None), "myeditor");
    std::env::remove_var("VMARK_EXTERNAL_EDITOR");
    std::env::remove_var("VISUAL");
    std::env::remove_var("EDITOR");
    if let Some(v) = _vmark {
        std::env::set_var("VMARK_EXTERNAL_EDITOR", v);
    }
    if let Some(v) = _visual {
        std::env::set_var("VISUAL", v);
    }
    if let Some(v) = _editor {
        std::env::set_var("EDITOR", v);
    }
}

#[test]
fn resolve_editor_falls_through_to_platform_default() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _vmark = std::env::var("VMARK_EXTERNAL_EDITOR").ok();
    let _visual = std::env::var("VISUAL").ok();
    let _editor = std::env::var("EDITOR").ok();
    std::env::remove_var("VMARK_EXTERNAL_EDITOR");
    std::env::remove_var("VISUAL");
    std::env::remove_var("EDITOR");
    let resolved = resolve_editor(None);
    assert!(!resolved.is_empty());
    if let Some(v) = _vmark {
        std::env::set_var("VMARK_EXTERNAL_EDITOR", v);
    }
    if let Some(v) = _visual {
        std::env::set_var("VISUAL", v);
    }
    if let Some(v) = _editor {
        std::env::set_var("EDITOR", v);
    }
}

#[test]
fn open_in_external_editor_rejects_missing_path() {
    let result = open_in_external_editor_blocking("/definitely/does/not/exist".to_string(), None);
    assert!(result.is_err());
}

#[test]
fn open_in_external_editor_rejects_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let result = open_in_external_editor_blocking(dir.path().to_string_lossy().into_owned(), None);
    assert!(result.is_err(), "directories must be rejected");
}

#[test]
fn open_in_external_editor_rejects_unsupported_extension() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("secret.bin");
    std::fs::write(&target, b"not a markdown file").expect("write");
    let result = open_in_external_editor_blocking(target.to_string_lossy().into_owned(), None);
    assert!(
        result.is_err(),
        "files with unregistered extensions must be rejected"
    );
}

/// WI-RA4.2 — the whole command, not just the validator: a script VMark can
/// open must not be runnable by naming a shell or interpreter as the editor.
/// The script is harmless (`exit 0`) because without the guard this call
/// executes it.
#[cfg(unix)]
#[test]
fn open_in_external_editor_refuses_to_run_a_script_through_an_interpreter_override() {
    let dir = tempfile::tempdir().expect("tempdir");
    let script = dir.path().join("harmless.sh");
    std::fs::write(&script, "exit 0\n").expect("write");
    let script = script.to_string_lossy().into_owned();

    for editor in ["sh", "bash", "/bin/sh", "/usr/bin/env", "python3", "node"] {
        let result = open_in_external_editor_blocking(script.clone(), Some(editor.to_string()));
        assert!(
            result.is_err(),
            "editor override {editor:?} would have executed the file"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn maybe_open_app_bundle_rewrites_dot_app_directory() {
    // /Applications/Calculator.app exists on every macOS install.
    let bundle = "/Applications/Calculator.app";
    if !Path::new(bundle).is_dir() {
        return; // Skip on macOS variants without Calculator.
    }
    let result = maybe_open_app_bundle(bundle, &[], "/tmp/file.md");
    let (exe, args) = result.expect(".app dir should rewrite");
    assert_eq!(exe, "open");
    assert_eq!(args, vec!["-a", bundle, "/tmp/file.md"]);
}

#[cfg(target_os = "macos")]
#[test]
fn maybe_open_app_bundle_returns_none_for_regular_executable() {
    let result = maybe_open_app_bundle("/bin/sh", &["-c"], "/tmp/file.md");
    assert!(
        result.is_none(),
        "regular executable should not trigger .app rewrite"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn maybe_open_app_bundle_returns_none_for_dot_app_string_that_isnt_a_dir() {
    // The string ends with .app but the path isn't a directory.
    let result = maybe_open_app_bundle("/tmp/not-real-cursor.app", &[], "/tmp/file.md");
    assert!(
        result.is_none(),
        "non-existent .app path should not trigger rewrite"
    );
}
