//! Tests for `mcp_bridge/path_guard.rs` (included via `#[path]`).
//!
//! WI-RA26.1 — the guard rejects with a typed `CommandError`: a malformed
//! path or root is `invalid-input`, a path outside every allowed root (or no
//! root at all) is `permission-denied`, and the frontend renders `message`.

use super::*;
use crate::command_error::ErrorCode;

#[test]
fn allows_existing_file_inside_root() {
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("note.md");
    std::fs::write(&file, "hi").expect("write");

    assert!(validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .is_ok());
}

#[test]
fn allows_new_file_inside_existing_root() {
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("sub").join("new.md");

    assert!(validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .is_ok());
}

#[test]
fn rejects_file_outside_root() {
    let ws = tempfile::tempdir().expect("ws");
    let outside = tempfile::tempdir().expect("outside");
    let file = outside.path().join("secret.md");
    std::fs::write(&file, "secret").expect("write");

    let err = validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .expect_err("a file in another directory is outside the root");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}

#[test]
fn rejects_parent_traversal() {
    let ws = tempfile::tempdir().expect("ws");
    let path = ws.path().join("..").join("secret.md");

    let err = validate_mcp_bridge_path(
        &path.to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .expect_err("parent traversal must be rejected");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert!(err.message().contains(".."));
}

#[cfg(unix)]
#[test]
fn rejects_existing_symlink_escape() {
    let ws = tempfile::tempdir().expect("ws");
    let outside = tempfile::tempdir().expect("outside");
    let target = outside.path().join("secret.md");
    std::fs::write(&target, "secret").expect("write");
    let link = ws.path().join("link.md");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");

    assert!(validate_mcp_bridge_path(
        &link.to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn rejects_new_file_under_symlinked_directory_escape() {
    let ws = tempfile::tempdir().expect("ws");
    let outside = tempfile::tempdir().expect("outside");
    let link = ws.path().join("linked-dir");
    std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
    let file = link.join("new.md");

    assert!(validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .is_err());
}

// --- JS↔Rust parity: mirror the cases pinned in mcpBridgePathPolicy.test.ts
//     so the two layers are verified to agree behaviorally, not just by
//     argument-name binding. ---

#[test]
fn rejects_null_byte() {
    // Parity with the JS policy's null-byte rejection. The NUL sits in a
    // not-yet-existing leaf, so without the explicit guard the deepest
    // existing ancestor (`ws`) would canonicalize cleanly and pass.
    let ws = tempfile::tempdir().expect("ws");
    let file_path = format!("{}/note\0.md", ws.path().to_string_lossy());

    let err = validate_mcp_bridge_path(&file_path, &[ws.path().to_string_lossy().into_owned()])
        .expect_err("null byte must be rejected");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert!(err.message().contains("null byte"));
}

#[test]
fn rejects_prefix_sibling_root() {
    // "/…/ws-evil" must NOT be treated as inside "/…/ws" — component-wise
    // starts_with, not a substring prefix (mirrors the JS substring-escape
    // test).
    let parent = tempfile::tempdir().expect("parent");
    let ws = parent.path().join("ws");
    let evil = parent.path().join("ws-evil");
    std::fs::create_dir(&ws).expect("ws");
    std::fs::create_dir(&evil).expect("evil");
    let file = evil.join("x.md");
    std::fs::write(&file, "hi").expect("write");

    assert!(validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[ws.to_string_lossy().into_owned()],
    )
    .is_err());
}

#[test]
fn allows_path_equal_to_root() {
    // A path equal to a root is within it (mirrors the JS "equal to a root"
    // case).
    let ws = tempfile::tempdir().expect("ws");

    assert!(validate_mcp_bridge_path(
        &ws.path().to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .is_ok());
}

#[test]
fn ignores_empty_string_roots() {
    // Empty-string roots are skipped; a real root still decides (mirrors the
    // JS "ignores empty-string roots" case).
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("note.md");
    std::fs::write(&file, "hi").expect("write");

    assert!(validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[String::new(), ws.path().to_string_lossy().into_owned()],
    )
    .is_ok());
}

#[test]
fn rejects_all_empty_or_no_roots() {
    // No usable root → reject (mirrors the JS empty-allowedRoots case).
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("note.md");
    std::fs::write(&file, "hi").expect("write");
    let target = file.to_string_lossy().into_owned();

    for roots in [vec![], vec![String::new()]] {
        let err = validate_mcp_bridge_path(&target, &roots).expect_err("no usable root");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
    }
}

#[test]
fn malformed_paths_are_invalid_input() {
    let ws = tempfile::tempdir().expect("ws");
    let roots = [ws.path().to_string_lossy().into_owned()];
    for bad in ["", "relative/note.md"] {
        let err = validate_mcp_bridge_path(bad, &roots).expect_err("malformed path");
        assert_eq!(err.code(), ErrorCode::InvalidInput, "{bad:?}");
    }
}

#[test]
fn a_relative_root_is_invalid_input() {
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("note.md");
    let err = validate_mcp_bridge_path(&file.to_string_lossy(), &["relative/root".to_string()])
        .expect_err("a relative root scopes nothing");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
}

#[test]
fn a_root_that_does_not_exist_is_not_found() {
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("note.md");
    let gone = ws.path().join("closed-workspace");
    let err = validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[gone.to_string_lossy().into_owned()],
    )
    .expect_err("a vanished root cannot be resolved");
    assert_eq!(err.code(), ErrorCode::NotFound);
}

#[test]
fn allows_a_cjk_named_file_inside_root() {
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("笔记").join("ノート.md");
    assert!(validate_mcp_bridge_path(
        &file.to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .is_ok());
}

#[cfg(unix)]
#[test]
fn a_symlink_escape_is_permission_denied() {
    let ws = tempfile::tempdir().expect("ws");
    let outside = tempfile::tempdir().expect("outside");
    let link = ws.path().join("linked-dir");
    std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");

    let err = validate_mcp_bridge_path(
        &link.join("new.md").to_string_lossy(),
        &[ws.path().to_string_lossy().into_owned()],
    )
    .expect_err("escape");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}

/// The command is what the frontend invokes; its rejection must be the typed
/// wire shape so `bridgePathGuard.ts` can render `message`.
#[test]
fn the_command_rejects_with_the_typed_wire_shape() {
    let ws = tempfile::tempdir().expect("ws");
    let outside = tempfile::tempdir().expect("outside");
    let err = mcp_bridge_check_path(
        outside.path().join("x.md").to_string_lossy().into_owned(),
        vec![ws.path().to_string_lossy().into_owned()],
    )
    .expect_err("outside");
    let wire = serde_json::to_value(&err).expect("serialize");
    assert_eq!(wire["code"], "permission-denied");
    assert_eq!(
        wire["message"],
        "Path is outside the workspace and open documents"
    );
}
