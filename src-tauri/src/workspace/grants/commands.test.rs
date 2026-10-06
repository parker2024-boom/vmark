//! Tests for `workspace/grants/commands.rs` — the webview's side of the grant.
//!
//! WI-LX1.1 — `allow_workspace_access` used to grant recursive fs + asset scope
//! on ANY path a script handed it, including `/`. It now re-issues only a root
//! the user chose (or a folder inside one) and refuses everything else with a
//! typed, localized `permission-denied`, extending nothing.
//!
//! Gated off Windows like every mock-runtime suite here: tauri's `test` feature
//! is not enabled there (see `fs_scope.test.rs`).
#![cfg(not(target_os = "windows"))]

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_fs::FsExt;

use super::allow_workspace_access;
use crate::command_error::{CommandError, ErrorCode};
use crate::workspace::grants::WorkspaceGrants;

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .plugin(tauri_plugin_fs::init())
        .manage(WorkspaceGrants::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

fn call(app: &tauri::App<tauri::test::MockRuntime>, path: &str) -> Result<String, CommandError> {
    tauri::async_runtime::block_on(allow_workspace_access(
        app.handle().clone(),
        path.to_owned(),
    ))
}

fn canonical(path: &Path) -> String {
    path.canonicalize()
        .expect("canonicalize")
        .to_str()
        .expect("utf-8")
        .to_owned()
}

/// `<tmp>/root/sub/note.md`, returning the tempdir, the root, and the file.
fn workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("root");
    std::fs::create_dir_all(root.join("sub")).expect("mkdir");
    let nested = root.join("sub").join("note.md");
    std::fs::write(&nested, b"# hi").expect("write");
    (dir, root, nested)
}

fn readable(app: &tauri::App<tauri::test::MockRuntime>, path: &Path) -> (bool, bool) {
    (
        app.fs_scope().is_allowed(path),
        app.asset_protocol_scope().is_allowed(path),
    )
}

/// Record `root` the way a pick does, WITHOUT granting it — so a test can tell
/// the command's own grant from one made earlier.
fn record_only(app: &tauri::App<tauri::test::MockRuntime>, root: &Path) -> String {
    let root = canonical(root);
    app.state::<WorkspaceGrants>().record(&root);
    root
}

#[test]
fn a_folder_nobody_chose_is_refused_and_nothing_is_granted() {
    let app = mock_app();
    let (_dir, root, nested) = workspace();

    let err = call(&app, root.to_str().unwrap()).expect_err("never chosen");

    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(
        readable(&app, &nested),
        (false, false),
        "the refusal extends nothing"
    );
}

#[test]
fn the_filesystem_root_is_refused() {
    let app = mock_app();

    let err = call(&app, "/").expect_err("`/` is the attack this exists to stop");

    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    for probe in ["/etc/hosts", "/private/etc/hosts", "/usr/bin/env"] {
        assert_eq!(readable(&app, Path::new(probe)), (false, false), "{probe}");
    }
}

/// It names the folder as the CALLER spelled it — never the canonical form,
/// which would tell a script where a link points (audit F2 #83).
#[test]
fn the_refusal_is_localized_and_names_the_folder_as_asked() {
    let app = mock_app();
    let (_dir, root, _nested) = workspace();
    let asked = root.to_str().unwrap();

    let err = call(&app, asked).expect_err("never chosen");

    assert_eq!(err.i18n_key(), Some("errors.workspaceAccess.notGranted"));
    assert!(err.message().contains(asked), "got: {}", err.message());
    if canonical(&root) != asked {
        // macOS temp dirs: `/var/…` is a link to `/private/var/…`.
        assert!(
            !err.message().contains(&canonical(&root)),
            "got: {}",
            err.message()
        );
    }
}

#[test]
fn a_chosen_root_is_granted_again() {
    let app = mock_app();
    let (_dir, root, nested) = workspace();
    let recorded = record_only(&app, &root);
    assert_eq!(readable(&app, &nested), (false, false));

    let granted = call(&app, root.to_str().unwrap()).expect("chosen before");

    assert_eq!(
        granted, recorded,
        "the canonical root is what the caller gets back"
    );
    assert_eq!(
        readable(&app, &nested),
        (true, true),
        "fs AND asset, recursively"
    );
}

#[test]
fn a_folder_inside_a_chosen_root_is_granted() {
    let app = mock_app();
    let (_dir, root, nested) = workspace();
    record_only(&app, &root);

    let granted = call(&app, root.join("sub").to_str().unwrap()).expect("inside a chosen tree");

    assert_eq!(granted, canonical(&root.join("sub")));
    assert_eq!(readable(&app, &nested), (true, true));
}

#[test]
fn a_sibling_that_shares_a_name_prefix_is_refused() {
    let app = mock_app();
    let (dir, root, _nested) = workspace();
    record_only(&app, &root);
    let sibling = dir.path().join("root-evil");
    std::fs::create_dir(&sibling).expect("mkdir");

    let err = call(&app, sibling.to_str().unwrap()).expect_err("a different folder");

    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}

#[test]
fn the_parent_of_a_chosen_root_is_refused() {
    let app = mock_app();
    let (dir, root, _nested) = workspace();
    record_only(&app, &root);

    let err = call(&app, dir.path().to_str().unwrap()).expect_err("wider than the choice");

    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}

/// The request is judged by what it RESOLVES to, not what it is called: a link
/// inside a chosen tree that points out of it is outside the choice.
#[cfg(unix)]
#[test]
fn a_link_out_of_a_chosen_root_is_refused() {
    let app = mock_app();
    let (_dir, root, _nested) = workspace();
    record_only(&app, &root);
    let outside = tempfile::tempdir().expect("outside");
    let secret = outside.path().join("secret.md");
    std::fs::write(&secret, b"# theirs").expect("write");
    let link = root.join("escape");
    std::os::unix::fs::symlink(outside.path(), &link).expect("link");

    let err = call(&app, link.to_str().unwrap()).expect_err("resolves outside");

    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(readable(&app, &secret), (false, false));
}

/// Outside the chosen folders, "missing" and "a file" are the same refusal as
/// any other (audit F2 #83); inside one, the real class is reported.
#[test]
fn a_missing_folder_or_a_file_nobody_chose_is_refused_like_any_other() {
    let app = mock_app();
    let (dir, _root, nested) = workspace();

    for path in [dir.path().join("gone"), nested] {
        let err = call(&app, path.to_str().unwrap()).expect_err("not chosen");
        assert_eq!(
            err.code(),
            ErrorCode::PermissionDenied,
            "{}",
            path.display()
        );
    }
}

#[test]
fn inside_a_chosen_root_a_missing_folder_is_not_found_and_a_file_invalid() {
    let app = mock_app();
    let (_dir, root, nested) = workspace();
    record_only(&app, &root);

    let err = call(&app, root.join("gone").to_str().unwrap()).expect_err("absent");
    assert_eq!(err.code(), ErrorCode::NotFound);
    let err = call(&app, nested.to_str().unwrap()).expect_err("not a folder");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
}

// -- Bounded checks (audit F2 #82) ---------------------------------------------
//
// Each check resolves a caller-named path on the blocking pool, and on a dead
// network mount one resolution holds a thread for the mount's timeout. So at
// most a few checks run at once, and a path already being checked is not
// checked again: a script repeating a dead-mount path costs one thread, not
// the pool. A refused check is `conflict`, answered at once.

#[test]
fn a_path_already_being_checked_is_refused_at_once() {
    let app = mock_app();
    let (_dir, root, _nested) = workspace();
    let _in_flight = app
        .state::<WorkspaceGrants>()
        .begin_check(&root)
        .expect("first check");

    let err = call(&app, root.to_str().unwrap()).expect_err("already in flight");

    assert_eq!(err.code(), ErrorCode::Conflict);
    assert_eq!(err.i18n_key(), Some("errors.workspaceAccess.checkBusy"));
}

#[test]
fn no_more_than_the_limit_run_at_once_and_a_finished_check_frees_its_place() {
    let app = mock_app();
    let (_dir, root, _nested) = workspace();
    let grants = app.state::<WorkspaceGrants>();
    let held: Vec<_> = (0..super::super::MAX_CONCURRENT_CHECKS)
        .map(|i| {
            grants
                .begin_check(PathBuf::from(format!("/held/{i}")))
                .expect("under the limit")
        })
        .collect();

    let err = call(&app, root.to_str().unwrap()).expect_err("at the limit");
    assert_eq!(err.code(), ErrorCode::Conflict);

    drop(held);
    let err = call(&app, root.to_str().unwrap()).expect_err("refused, but CHECKED");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
}

#[test]
fn a_relative_path_is_invalid_input() {
    // It would resolve against a working directory the webview did not choose
    // (audit #491/#493) — so it is refused before anything is resolved.
    let app = mock_app();

    let err = call(&app, "some/relative/dir").expect_err("relative");

    assert_eq!(err.code(), ErrorCode::InvalidInput);
}

/// A re-grant that does not take is an error, not a root: the caller would open
/// a workspace it cannot read. A forbidden pattern outranks any allow.
#[test]
fn a_chosen_root_whose_grant_does_not_take_is_an_error() {
    let app = mock_app();
    let (_dir, root, nested) = workspace();
    record_only(&app, &root);
    app.fs_scope()
        .forbid_directory(&root, true)
        .expect("forbid");

    let err = call(&app, root.to_str().unwrap()).expect_err("nothing became readable");

    assert_eq!(err.code(), ErrorCode::Internal);
    assert!(!app.fs_scope().is_allowed(&nested));
}
