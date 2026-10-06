//! Tests for `files/ops.rs` (included via `#[path]`).
//!
//! WI-RA26.1 — both commands reject with a typed `CommandError` whose `code`
//! names the class: a missing path is `not-found`, a directory is
//! `invalid-input`, an untraversable parent is `permission-denied`.

use super::*;
use crate::command_error::ErrorCode;
use std::io::Write;

/// Helper: create a markdown-named file in a tempdir with the given bytes
/// and return (tempdir, absolute-path).
fn make_md_file(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fixture.md");
    let mut f = std::fs::File::create(&path).expect("create");
    f.write_all(bytes).expect("write");
    (dir, path)
}

#[tokio::test]
async fn reports_size_for_existing_file() {
    let (_dir, path) = make_md_file(b"hello");
    let size = get_file_size_bytes(path.to_string_lossy().into_owned())
        .await
        .expect("ok");
    assert_eq!(size, 5);
}

#[tokio::test]
async fn empty_file_reports_zero() {
    let (_dir, path) = make_md_file(b"");
    let size = get_file_size_bytes(path.to_string_lossy().into_owned())
        .await
        .expect("ok");
    assert_eq!(size, 0);
}

#[tokio::test]
async fn missing_file_is_not_found() {
    let err = get_file_size_bytes("/nonexistent/path/vmark-test.md".to_string())
        .await
        .expect_err("expected err for missing path");
    assert_eq!(err.code(), ErrorCode::NotFound);
    assert!(
        err.message().contains("/nonexistent/path/vmark-test.md"),
        "the message names the path: {}",
        err.message()
    );
}

#[tokio::test]
async fn empty_path_is_not_found() {
    let err = get_file_size_bytes(String::new())
        .await
        .expect_err("an empty path names no file");
    assert_eq!(err.code(), ErrorCode::NotFound);
}

#[tokio::test]
async fn non_markdown_extension_is_allowed() {
    // The open dialog also accepts .txt, so the size-check must not
    // gatekeep on extension (regression guard).
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fixture.txt");
    std::fs::write(&path, b"hi").expect("write");
    let size = get_file_size_bytes(path.to_string_lossy().into_owned())
        .await
        .expect("txt file should succeed");
    assert_eq!(size, 2);
}

#[tokio::test]
async fn cjk_file_name_reports_its_byte_size() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("笔记 ノート.md");
    std::fs::write(&path, "中文".as_bytes()).expect("write");
    let size = get_file_size_bytes(path.to_string_lossy().into_owned())
        .await
        .expect("a CJK name is an ordinary file");
    assert_eq!(size, 6);
}

#[tokio::test]
async fn directory_is_refused_as_invalid_input() {
    // A directory is a "non-regular file" and must be rejected so the
    // command cannot be repurposed to probe folder existence.
    let dir = tempfile::tempdir().expect("tempdir");
    let err = get_file_size_bytes(dir.path().to_string_lossy().into_owned())
        .await
        .expect_err("directories must be refused");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert!(err.message().contains("not a regular file"));
}

#[cfg(unix)]
#[tokio::test]
async fn follows_symlinks_to_real_file() {
    let (_dir, target) = make_md_file(b"abcdef");
    let link_dir = tempfile::tempdir().expect("tempdir");
    let link_path = link_dir.path().join("link.md");
    std::os::unix::fs::symlink(&target, &link_path).expect("symlink");

    let size = get_file_size_bytes(link_path.to_string_lossy().into_owned())
        .await
        .expect("ok");
    assert_eq!(size, 6);
}

#[cfg(unix)]
#[tokio::test]
async fn broken_symlink_is_not_found() {
    let dir = tempfile::tempdir().expect("tempdir");
    let link_path = dir.path().join("broken.md");
    std::os::unix::fs::symlink("/nonexistent/target/vmark-test", &link_path).expect("symlink");

    let err = get_file_size_bytes(link_path.to_string_lossy().into_owned())
        .await
        .expect_err("broken symlinks must surface an error");
    assert_eq!(err.code(), ErrorCode::NotFound);
}

/// A file whose parent denies traversal (mode `0o000`) is unreadable.
/// `canonicalize()` returns `Err(PermissionDenied)`; the command reports
/// that class rather than flattening it into "not found".
#[cfg(unix)]
#[tokio::test]
async fn permission_denied_is_permission_denied() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("tempdir");
    let victim = dir.path().join("secret.md");
    std::fs::write(&victim, b"secret").expect("write");

    // Strip all bits from the parent so traversal to the file fails.
    let parent = dir.path();
    let original = std::fs::metadata(parent)
        .expect("stat parent")
        .permissions();
    let mut locked = original.clone();
    locked.set_mode(0o000);

    // Skip on systems where the running user is effectively root (rare in CI,
    // but possible): root bypasses permission checks.
    // SAFETY: `geteuid` takes no arguments, cannot fail and touches no memory.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping permission_denied_is_permission_denied under euid 0");
        return;
    }

    std::fs::set_permissions(parent, locked).expect("chmod lock");

    // Make the permission fix unconditional even on panic.
    let _restore = scopeguard_restore(parent.to_path_buf(), original);

    let err = get_file_size_bytes(victim.to_string_lossy().into_owned())
        .await
        .expect_err("permission-denied paths must surface an error");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}

/// Tiny hand-rolled scope guard so we don't pull a crate for one call site.
#[cfg(unix)]
fn scopeguard_restore(path: std::path::PathBuf, perms: std::fs::Permissions) -> impl Drop {
    struct Restore(std::path::PathBuf, std::fs::Permissions);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, self.1.clone());
        }
    }
    Restore(path, perms)
}

/// The rejection crosses the IPC boundary as the typed wire shape, so the
/// frontend can branch on `code` instead of matching message text.
#[tokio::test]
async fn the_rejection_serializes_as_a_typed_error() {
    let err = get_file_size_bytes("/nonexistent/vmark-wire.md".to_string())
        .await
        .expect_err("missing");
    let wire = serde_json::to_value(&err).expect("serialize");
    assert_eq!(wire["code"], "not-found");
    assert!(wire["message"].is_string());
}

// Real trashing is NOT exercised here: it would litter the developer's /
// CI runner's actual Trash. These cover the guard rails — the paths that
// must FAIL into the outcome rather than error the whole batch.

#[tokio::test]
async fn missing_file_lands_in_failed_not_err() {
    let outcome = move_paths_to_trash(vec!["/nonexistent/vmark-test.png".into()])
        .await
        .expect("batch itself must not error");
    assert!(outcome.trashed.is_empty());
    assert_eq!(outcome.failed.len(), 1);
    assert_eq!(outcome.failed[0].path, "/nonexistent/vmark-test.png");
    assert!(
        outcome.failed[0]
            .error
            .contains("/nonexistent/vmark-test.png"),
        "the per-path reason is readable text, not a serialized object: {}",
        outcome.failed[0].error
    );
}

#[tokio::test]
async fn directory_is_refused_by_trash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let outcome = move_paths_to_trash(vec![dir.path().to_string_lossy().into_owned()])
        .await
        .expect("ok");
    assert!(outcome.trashed.is_empty());
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0].error.contains("not a regular file"));
}

#[tokio::test]
async fn empty_batch_is_empty_outcome() {
    let outcome = move_paths_to_trash(vec![]).await.expect("ok");
    assert!(outcome.trashed.is_empty());
    assert!(outcome.failed.is_empty());
}

#[tokio::test]
async fn one_bad_path_does_not_poison_the_batch() {
    let outcome = move_paths_to_trash(vec![
        "/nonexistent/a.png".into(),
        "/nonexistent/b.png".into(),
    ])
    .await
    .expect("ok");
    assert_eq!(outcome.failed.len(), 2);
}
