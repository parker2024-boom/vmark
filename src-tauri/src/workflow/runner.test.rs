//! Tests kept beside the runner: the built-in actions and the parameter
//! resolver, called the way a step reaches them. Whole runs are in
//! `runner_flow.test.rs`, and each step phase has its own test file.

use super::*;
use crate::workflow::actions::{execute_action, matches_accept};
use crate::workflow::expressions::{self, WorkflowOutputs};

#[tokio::test]
async fn test_execute_action_notify() {
    let mut params = HashMap::new();
    params.insert("message".to_string(), "Hello".to_string());
    let root = std::path::Path::new("/tmp");
    let result = execute_action("action/notify", &params, root).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "Hello");
}

#[tokio::test]
async fn test_execute_action_copy() {
    let mut params = HashMap::new();
    params.insert("input".to_string(), "test data".to_string());
    let root = std::path::Path::new("/tmp");
    let result = execute_action("action/copy", &params, root).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "test data");
}

#[tokio::test]
async fn test_execute_action_unknown() {
    let params = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let result = execute_action("action/unknown", &params, root).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_prompt_returns_error() {
    let params = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let result = execute_action("action/prompt", &params, root).await;
    assert!(result.is_err());
}

#[test]
fn test_matches_accept() {
    assert!(matches_accept("readme.md", "*"));
    assert!(matches_accept("readme.md", "*.md"));
    assert!(matches_accept("readme.md", ".md"));
    assert!(!matches_accept("readme.md", "*.txt"));
    // #505 — every other extension gate in VMark folds ASCII case, so `*.md`
    // excluding `README.MD` from a folder read was a disagreement with the
    // editor that opened the same file happily.
    assert!(matches_accept("README.MD", "*.md"));
    assert!(matches_accept("notes.Md", ".md"));
    assert!(matches_accept("readme.md", "*.MD"));
    assert!(!matches_accept("README.MD", "*.txt"));
}

#[test]
fn test_env_substitution_via_resolver() {
    // Legacy ${VAR} syntax still works via the new expression resolver.
    let env: HashMap<String, String> = [("DIR".to_string(), "notes".to_string())].into();
    let outputs = WorkflowOutputs::new();
    let result = expressions::resolve("output/${DIR}/file.md", &outputs, &env).unwrap();
    assert_eq!(result, "output/notes/file.md");
}

#[test]
fn test_env_substitution_multiple_vars_via_resolver() {
    let env: HashMap<String, String> = [
        ("A".to_string(), "hello".to_string()),
        ("B".to_string(), "world".to_string()),
    ]
    .into();
    let outputs = WorkflowOutputs::new();
    let result = expressions::resolve("${A}/${B}", &outputs, &env).unwrap();
    assert_eq!(result, "hello/world");
}

// -- audit g3-rust-rest regression tests --------------------------------------

#[cfg(unix)]
#[tokio::test]
async fn test_read_folder_skips_symlink_escaping_workspace() {
    let ws = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.md");
    std::fs::write(&secret, "TOP-SECRET").unwrap();
    std::fs::write(ws.path().join("inside.md"), "INSIDE-OK").unwrap();
    std::os::unix::fs::symlink(&secret, ws.path().join("leak.md")).unwrap();

    let mut params = HashMap::new();
    params.insert("path".to_string(), ".".to_string());
    let output = execute_action("action/read-folder", &params, ws.path())
        .await
        .unwrap();
    assert!(output.contains("INSIDE-OK"));
    assert!(
        !output.contains("TOP-SECRET"),
        "symlink escaping the workspace must not be read"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn test_read_folder_allows_symlink_within_workspace() {
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("real.md"), "REAL-CONTENT").unwrap();
    std::os::unix::fs::symlink(ws.path().join("real.md"), ws.path().join("alias.txt")).unwrap();

    let mut params = HashMap::new();
    params.insert("path".to_string(), ".".to_string());
    params.insert("accept".to_string(), "*.txt".to_string());
    let output = execute_action("action/read-folder", &params, ws.path())
        .await
        .unwrap();
    assert!(output.contains("REAL-CONTENT"));
}

#[test]
fn test_matches_accept_comma_separated_list() {
    assert!(matches_accept("readme.md", "*.md,*.txt"));
    assert!(matches_accept("notes.txt", "*.md,*.txt"));
    assert!(!matches_accept("image.png", "*.md,*.txt"));
    // Whitespace around patterns is tolerated.
    assert!(matches_accept("notes.txt", "*.md, *.txt"));
    // Empty accept behaves like "*" (matches everything).
    assert!(matches_accept("anything.bin", ""));
}

// === the cancel bridge ===

/// The job the bridge exists for. The clock is paused: the bridge finds the
/// flag on its next poll, which virtual time reaches without waiting.
#[tokio::test(start_paused = true)]
async fn the_cancel_bridge_carries_the_flag_to_the_token() {
    let flag = Arc::new(AtomicBool::new(false));
    let token = CancellationToken::new();
    let bridge = spawn_cancel_bridge(Arc::clone(&flag), token.clone());
    tokio::task::yield_now().await;
    assert!(!token.is_cancelled(), "nothing was requested yet");

    flag.store(true, Ordering::SeqCst);
    token.cancelled().await;
    bridge
        .await
        .expect("the bridge ends once the token is cancelled");
}

/// A run that ends cancels its own token, and the bridge must end THEN, not
/// on its next tick. No clock here: a few turns of the scheduler are over
/// long before a poll interval is.
#[tokio::test]
async fn the_cancel_bridge_stops_as_soon_as_its_token_is_cancelled() {
    let flag = Arc::new(AtomicBool::new(false));
    let token = CancellationToken::new();
    let bridge = spawn_cancel_bridge(Arc::clone(&flag), token.clone());
    tokio::task::yield_now().await;

    token.cancel();
    for _ in 0..16 {
        if bridge.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        bridge.is_finished(),
        "the bridge is still waiting out its poll interval"
    );
    assert!(
        !flag.load(Ordering::SeqCst),
        "ending the bridge is not a cancel request"
    );
}
