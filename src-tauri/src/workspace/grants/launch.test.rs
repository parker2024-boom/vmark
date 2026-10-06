//! Tests for `workspace/grants/launch.rs` — re-granting recorded roots at
//! launch, within a bounded wait.
//!
//! WI-LX1.1 — launch must not wait on a stale mount, a stale mount must not
//! hold back the valid roots listed after it, and what became of each root is
//! reported rather than guessed. The resolver is injected so a root can hang or
//! panic on demand. Gated like every mock-runtime suite in the crate: tauri's
//! `test` feature is off on Windows.
#![cfg(not(target_os = "windows"))]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri_plugin_fs::FsExt;

use super::{regrant_all, Regrant};
use crate::command_error::CommandError;
use crate::workspace::grants::{canonical_dir, WorkspaceGrants};

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .plugin(tauri_plugin_fs::init())
        .manage(WorkspaceGrants::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

/// A canonical root with a file inside it.
fn root() -> (tempfile::TempDir, String, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let nested = dir.path().join("note.md");
    std::fs::write(&nested, b"# hi").expect("write");
    let root = canonical_dir(dir.path()).expect("a folder");
    (dir, root, nested)
}

/// Resolves normally, except `hung`, which blocks well past any wait here —
/// what `canonicalize` does on a stale network mount.
fn hanging_on(hung: String) -> Arc<super::Resolve> {
    Arc::new(move |path: &Path| {
        if path == Path::new(&hung) {
            std::thread::sleep(Duration::from_secs(3));
            return Err(CommandError::io("the mount timed out"));
        }
        canonical_dir(path)
    })
}

#[test]
fn every_resolvable_root_is_granted() {
    let app = mock_app();
    let (_a, first, first_file) = root();
    let (_b, second, second_file) = root();

    let outcomes = regrant_all(
        app.handle(),
        vec![first.clone(), second.clone()],
        Duration::from_secs(10),
        Arc::new(canonical_dir),
    );

    assert_eq!(
        outcomes,
        [(first, Regrant::Granted), (second, Regrant::Granted)]
    );
    assert!(app.fs_scope().is_allowed(&first_file));
    assert!(app.fs_scope().is_allowed(&second_file));
}

#[test]
fn a_hung_root_does_not_hold_back_the_roots_after_it() {
    let app = mock_app();
    let (_hung_dir, hung, _) = root();
    let (_ok_dir, valid, valid_file) = root();
    let started = Instant::now();

    let outcomes = regrant_all(
        app.handle(),
        vec![hung.clone(), valid.clone()],
        Duration::from_millis(300),
        hanging_on(hung.clone()),
    );

    assert!(
        started.elapsed() < Duration::from_secs(2),
        "launch did not wait for the hung root"
    );
    assert_eq!(
        outcomes[1],
        (valid, Regrant::Granted),
        "granted within the wait"
    );
    assert!(app.fs_scope().is_allowed(&valid_file));
    assert_eq!(
        outcomes[0],
        (hung, Regrant::Pending),
        "reported, not dropped"
    );
}

#[test]
fn a_root_whose_resolution_panics_is_a_failure_not_still_running() {
    let app = mock_app();
    let (_bad_dir, bad, _) = root();
    let (_ok_dir, valid, _) = root();
    let panicking = bad.clone();
    let resolve: Arc<super::Resolve> = Arc::new(move |path: &Path| {
        if path == Path::new(&panicking) {
            panic!("resolver bug");
        }
        canonical_dir(path)
    });
    let started = Instant::now();

    let outcomes = regrant_all(
        app.handle(),
        vec![bad.clone(), valid.clone()],
        Duration::from_secs(10),
        resolve,
    );

    assert!(
        started.elapsed() < Duration::from_secs(5),
        "a panic ends the wait; it is not waited out as if still running"
    );
    assert!(
        matches!(&outcomes[0], (root, Regrant::Failed(_)) if *root == bad),
        "{outcomes:?}"
    );
    assert_eq!(
        outcomes[1],
        (valid, Regrant::Granted),
        "the others still run"
    );
}

#[test]
fn a_root_that_now_resolves_elsewhere_is_reported_moved_and_not_granted() {
    let app = mock_app();
    let (_dir, recorded, nested) = root();
    let (_other, elsewhere, _) = root();
    let target = elsewhere.clone();
    let resolve: Arc<super::Resolve> = Arc::new(move |_: &Path| Ok(target.clone()));

    let outcomes = regrant_all(
        app.handle(),
        vec![recorded.clone()],
        Duration::from_secs(10),
        resolve,
    );

    assert_eq!(outcomes, [(recorded, Regrant::Moved(elsewhere))]);
    assert!(!app.fs_scope().is_allowed(&nested));
}

#[test]
fn no_recorded_roots_is_nothing_to_wait_for() {
    let app = mock_app();
    let started = Instant::now();
    let outcomes = regrant_all(
        app.handle(),
        Vec::new(),
        Duration::from_secs(10),
        hanging_on(String::new()),
    );
    assert!(outcomes.is_empty());
    assert!(started.elapsed() < Duration::from_secs(1));
}
