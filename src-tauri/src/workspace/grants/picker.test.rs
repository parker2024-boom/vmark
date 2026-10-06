//! Tests for `workspace/grants/picker.rs` — the folder pickers.
//!
//! WI-LX1.1 — the one dialog slot, through each command's WHOLE body, and every
//! kind of answer. The native panel is injected: MockRuntime cannot show one,
//! so `show` itself (a dozen lines of builder calls) needs a running app — the
//! e2e tier — and is the only part not exercised here. Gated like every
//! mock-runtime suite in the crate: tauri's `test` feature is off on Windows.
#![cfg(not(target_os = "windows"))]

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_dialog::FilePath;
use tauri_plugin_fs::FsExt;
use tokio::sync::oneshot;

use super::{claim, confirm_with, pick_with, request_workspace_confirmation, settle, Answer};
use crate::command_error::{CommandError, ErrorCode};
use crate::workspace::grants::WorkspaceGrants;

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .plugin(tauri_plugin_fs::init())
        .manage(WorkspaceGrants::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
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

fn answer(value: Answer) -> oneshot::Receiver<Answer> {
    let (tx, rx) = oneshot::channel();
    tx.send(value).expect("receiver alive");
    rx
}

fn settled(
    app: &tauri::App<tauri::test::MockRuntime>,
    answered: oneshot::Receiver<Answer>,
) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::block_on(async { settle(app.handle(), answered.await).await })
}

fn slot_is_free(app: &tauri::App<tauri::test::MockRuntime>) -> bool {
    claim(app.handle()).is_ok()
}

// -- What an answer does -------------------------------------------------------

#[test]
fn a_picked_folder_is_granted_recorded_and_returned_canonical() {
    let app = mock_app();
    let (_dir, root, nested) = workspace();

    let picked = settled(&app, answer(Some(FilePath::Path(root.clone())))).expect("a folder");

    assert_eq!(picked, Some(canonical(&root)));
    assert_eq!(readable(&app, &nested), (true, true));
    assert!(app.state::<WorkspaceGrants>().covers(&canonical(&root)));
}

#[test]
fn a_cancelled_dialog_grants_and_records_nothing() {
    let app = mock_app();
    let (_dir, _root, nested) = workspace();

    assert_eq!(settled(&app, answer(None)).expect("a cancel"), None);
    assert_eq!(readable(&app, &nested), (false, false));
}

#[test]
fn a_dialog_that_never_answers_is_an_internal_error() {
    let app = mock_app();
    let (tx, rx) = oneshot::channel::<Answer>();
    drop(tx);

    let err = settled(&app, rx).expect_err("no answer");

    assert_eq!(err.code(), ErrorCode::Internal);
}

#[test]
fn an_answer_that_is_not_a_local_folder_is_refused_unrecorded() {
    let app = mock_app();
    let (_dir, _root, nested) = workspace();
    let url = tauri::Url::parse("https://example.com/folder").expect("url");

    let err = settled(&app, answer(Some(FilePath::Url(url)))).expect_err("not a path");
    assert_eq!(err.code(), ErrorCode::InvalidInput);

    let err = settled(&app, answer(Some(FilePath::Path(nested.clone())))).expect_err("a file");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert!(!app.state::<WorkspaceGrants>().covers(&canonical(&nested)));
}

#[test]
fn one_dialog_at_a_time_and_the_slot_frees_when_it_closes() {
    let app = mock_app();
    let open = claim(app.handle()).expect("no dialog open yet");

    let err = claim(app.handle()).err().expect("a dialog is open");
    assert_eq!(err.code(), ErrorCode::Conflict);
    assert_eq!(err.i18n_key(), Some("errors.workspaceAccess.pickerBusy"));

    drop(open);
    assert!(slot_is_free(&app), "closing frees the slot");
}

// -- The slot through `pick_workspace_folder`'s body (audit F2 #85) -----------

/// While the dialog is up the slot is held — a second dialog is refused — and
/// it is freed once the answer is settled, whatever the answer was. The panel
/// is told where to open: at an absolute default, and nowhere for a relative
/// one (it would resolve against a working directory nothing chose).
#[test]
fn the_picker_holds_the_slot_while_up_and_frees_it_for_every_answer() {
    let app = mock_app();
    let (_dir, root, _nested) = workspace();
    let answers: Vec<(Option<String>, Option<PathBuf>, Answer)> = vec![
        (
            Some(root.to_str().unwrap().to_owned()),
            Some(root.clone()),
            None,
        ),
        (Some("relative/dir".to_owned()), None, None),
        (None, None, Some(FilePath::Path(root.clone()))),
        (
            None,
            None,
            Some(FilePath::Path(root.join("sub").join("note.md"))),
        ),
    ];
    for (default_path, expected_start, reply) in answers {
        let result =
            tauri::async_runtime::block_on(pick_with(app.handle(), default_path, |start| {
                assert_eq!(start, expected_start, "where the panel opens");
                assert!(
                    !slot_is_free(&app),
                    "a second dialog is refused while this one is up"
                );
                answer(reply)
            }));
        let _ = result;
        assert!(slot_is_free(&app), "the slot is freed after the answer");
    }
}

#[test]
fn the_picker_is_refused_while_another_dialog_is_open() {
    let app = mock_app();
    let _open = claim(app.handle()).expect("free");
    let mut shown = false;

    let err = tauri::async_runtime::block_on(pick_with(app.handle(), None, |_| {
        shown = true;
        answer(None)
    }))
    .expect_err("busy");

    assert_eq!(err.code(), ErrorCode::Conflict);
    assert!(!shown, "no dialog was shown");
}

// -- Launch detection for the confirmation request (audit F2 #146) ------------
//
// The request answers before the user does, so it must tell "the panel is up"
// from "it never came up". The plugin reports neither; what it does is drop
// the callback (the closure never ran) or answer at once (a platform with no
// working picker). Both are launch failures. Silence through the grace period
// is a panel on screen.

const GRACE: Duration = Duration::from_millis(100);

fn confirm(
    app: &tauri::App<tauri::test::MockRuntime>,
    path: &Path,
    shown: oneshot::Receiver<Answer>,
) -> Result<(), CommandError> {
    tauri::async_runtime::block_on(confirm_with(
        app.handle(),
        path.to_str().unwrap().to_owned(),
        |_| shown,
        GRACE,
    ))
}

#[test]
fn a_dialog_whose_callback_is_dropped_never_launched() {
    let app = mock_app();
    let (_dir, root, _nested) = workspace();
    let (tx, rx) = oneshot::channel::<Answer>();
    drop(tx);

    let err = confirm(&app, &root, rx).expect_err("not shown");

    assert_eq!(err.code(), ErrorCode::Internal);
    assert!(slot_is_free(&app), "a failed launch frees the slot");
}

#[test]
fn a_dialog_that_answers_before_anyone_could_is_a_failed_launch() {
    let app = mock_app();
    let (_dir, root, _nested) = workspace();

    let err = confirm(&app, &root, answer(None)).expect_err("closed at once");

    assert_eq!(err.code(), ErrorCode::Internal);
    assert!(slot_is_free(&app));
}

#[test]
fn a_dialog_still_up_after_the_grace_is_shown_and_its_answer_is_recorded_later() {
    let app = mock_app();
    let (_dir, root, nested) = workspace();
    let (reply, shown) = oneshot::channel::<Answer>();

    confirm(&app, &root, shown).expect("the panel is up");
    assert!(
        !slot_is_free(&app),
        "the slot is held until the user answers"
    );

    reply
        .send(Some(FilePath::Path(root.clone())))
        .expect("still waiting");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !app.state::<WorkspaceGrants>().covers(&canonical(&root)) {
        assert!(
            std::time::Instant::now() < deadline,
            "the pick was never recorded"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(readable(&app, &nested), (true, true));
    while !slot_is_free(&app) {
        assert!(
            std::time::Instant::now() < deadline,
            "the slot was never freed"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Through the command itself, the refusals arrive before any dialog is shown:
/// while another dialog is open it is `conflict` (the MCP tool reports BUSY),
/// and a relative folder is refused without claiming the slot.
#[test]
fn a_confirmation_request_is_refused_before_anything_is_shown() {
    let app = mock_app();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("window");
    let window = AsRef::<tauri::Webview<_>>::as_ref(&webview).window();
    let request = |path: &str| {
        tauri::async_runtime::block_on(request_workspace_confirmation(
            app.handle().clone(),
            window.clone(),
            path.to_owned(),
        ))
    };

    let err = request("relative/dir").expect_err("not absolute");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert!(claim(app.handle()).is_ok(), "the refusal claimed nothing");

    let open = claim(app.handle()).expect("free");
    let (_dir, root, _nested) = workspace();
    let err = request(root.to_str().unwrap()).expect_err("another dialog is open");
    assert_eq!(err.code(), ErrorCode::Conflict);
    drop(open);
}
