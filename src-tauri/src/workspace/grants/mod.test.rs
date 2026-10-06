//! Tests for `workspace/grants/mod.rs` — choosing a root, persisting it, and
//! re-issuing it at launch.
//!
//! WI-LX1.1 — a picked or Finder-opened root is granted and recorded; a
//! recorded root is granted again after a restart; a recorded name that now
//! resolves somewhere else is NOT.
//!
//! tauri::test::MockRuntime crashes the test binary at startup on
//! windows-latest (STATUS_ENTRYPOINT_NOT_FOUND) and tauri's `test` feature is
//! not enabled there, so the mock-app tests are gated like every other suite
//! of this kind in the crate (`fs_scope.test.rs`).

use super::WorkspaceGrants;

#[test]
fn a_second_picker_is_refused_while_one_is_open() {
    let grants = WorkspaceGrants::default();
    let first = grants.begin_picker().expect("no picker open yet");
    assert!(
        grants.begin_picker().is_none(),
        "one folder dialog at a time"
    );
    drop(first);
    assert!(
        grants.begin_picker().is_some(),
        "closing the dialog frees the slot"
    );
}

#[cfg(not(target_os = "windows"))]
mod with_app {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use tauri::Manager;
    use tauri_plugin_fs::FsExt;

    use super::super::{grant_chosen_root, restore_from, WorkspaceGrants, GRANTS_FILE};
    use crate::command_error::ErrorCode;

    const WAIT: Duration = Duration::from_secs(10);

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

    /// `<tmp>/root/sub/deeper/note.md`, returning the root and the nested file.
    fn workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("root");
        let deeper = root.join("sub").join("deeper");
        std::fs::create_dir_all(&deeper).expect("mkdir");
        let nested = deeper.join("note.md");
        std::fs::write(&nested, b"# hi").expect("write");
        (dir, root, nested)
    }

    fn readable<R: tauri::Runtime>(app: &tauri::App<R>, path: &Path) -> (bool, bool) {
        (
            app.fs_scope().is_allowed(path),
            app.asset_protocol_scope().is_allowed(path),
        )
    }

    #[test]
    fn a_chosen_root_is_granted_recursively_and_recorded() {
        let app = mock_app();
        let (_dir, root, nested) = workspace();
        assert_eq!(
            readable(&app, &nested),
            (false, false),
            "nothing granted yet"
        );

        let granted = grant_chosen_root(app.handle(), &root).expect("a real folder");

        assert_eq!(
            granted,
            canonical(&root),
            "the canonical target is what is granted"
        );
        assert_eq!(
            readable(&app, &nested),
            (true, true),
            "fs AND asset, whole tree"
        );
        assert!(app.state::<WorkspaceGrants>().covers(&granted));
    }

    #[test]
    fn choosing_a_file_grants_and_records_nothing() {
        let app = mock_app();
        let (_dir, _root, nested) = workspace();

        let err = grant_chosen_root(app.handle(), &nested).expect_err("a file is not a root");

        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert_eq!(readable(&app, &nested), (false, false));
        assert!(!app.state::<WorkspaceGrants>().covers(&canonical(&nested)));
    }

    #[test]
    fn choosing_a_missing_folder_is_not_found() {
        let app = mock_app();
        let (dir, _root, _nested) = workspace();

        let err =
            grant_chosen_root(app.handle(), &dir.path().join("gone")).expect_err("nothing there");

        assert_eq!(err.code(), ErrorCode::NotFound);
    }

    #[test]
    fn a_chosen_root_is_granted_again_after_a_restart() {
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);
        let (_dir, root, nested) = workspace();

        let first = mock_app();
        restore_from(first.handle(), file.clone(), WAIT);
        grant_chosen_root(first.handle(), &root).expect("grant");
        assert!(file.exists(), "the choice is persisted when it is made");

        // A new process: runtime grants start empty.
        let second = mock_app();
        assert_eq!(readable(&second, &nested), (false, false));
        restore_from(second.handle(), file, WAIT);

        assert_eq!(
            readable(&second, &nested),
            (true, true),
            "re-issued at launch"
        );
        assert!(second.state::<WorkspaceGrants>().covers(&canonical(&root)));
    }

    /// #250 in another place: Tauri's `push_pattern` also inserts the CANONICAL
    /// form of whatever it is given, resolved at grant time. Re-granting a
    /// recorded NAME that has since become a link would grant the link's target.
    #[cfg(unix)]
    #[test]
    fn a_recorded_root_that_now_resolves_elsewhere_is_not_granted_at_launch() {
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);
        let (_dir, root, _nested) = workspace();
        let elsewhere = tempfile::tempdir().expect("elsewhere");
        let secret = elsewhere.path().join("secret.md");
        std::fs::write(&secret, b"# theirs").expect("write");

        let first = mock_app();
        restore_from(first.handle(), file.clone(), WAIT);
        let recorded = grant_chosen_root(first.handle(), &root).expect("grant");

        // The recorded folder is replaced by a link to somewhere else.
        std::fs::remove_dir_all(&recorded).expect("rm root");
        std::os::unix::fs::symlink(elsewhere.path(), &recorded).expect("link");

        let second = mock_app();
        restore_from(second.handle(), file, WAIT);

        assert_eq!(
            readable(&second, &secret),
            (false, false),
            "the target was never chosen"
        );
        assert_eq!(
            readable(&second, &Path::new(&recorded).join("secret.md")),
            (false, false),
            "nor is it reachable through the old name"
        );
    }

    /// A Finder open can arrive before setup loads the list (macOS delivers
    /// `Opened` ahead of `Ready` on a cold start). That root is merged in
    /// memory, and it must reach the file even though the file already exists.
    #[test]
    fn a_root_chosen_before_the_list_loads_survives_the_next_restart() {
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);
        let (_older_dir, older, _) = workspace();
        let (_early_dir, early, early_nested) = workspace();

        let first = mock_app();
        restore_from(first.handle(), file.clone(), WAIT);
        grant_chosen_root(first.handle(), &older).expect("an earlier session's choice");

        let second = mock_app();
        grant_chosen_root(second.handle(), &early).expect("chosen before the list loads");
        restore_from(second.handle(), file.clone(), WAIT);

        let third = mock_app();
        restore_from(third.handle(), file, WAIT);
        let grants = third.state::<WorkspaceGrants>();
        assert!(
            grants.covers(&canonical(&early)),
            "the early choice was persisted"
        );
        assert!(
            grants.covers(&canonical(&older)),
            "and the file's roots kept"
        );
        assert_eq!(readable(&third, &early_nested), (true, true));
    }

    /// A grant that did not take is a failure, not a choice to remember: the
    /// window it would open could read nothing. A forbidden pattern outranks
    /// any allow, so the grant call succeeds and changes nothing.
    #[test]
    fn a_grant_that_does_not_take_is_an_error_and_is_not_recorded() {
        let app = mock_app();
        let (_dir, root, nested) = workspace();
        app.fs_scope()
            .forbid_directory(&root, true)
            .expect("forbid");

        let err = grant_chosen_root(app.handle(), &root).expect_err("nothing became readable");

        assert_eq!(err.code(), ErrorCode::Internal);
        assert!(!app.state::<WorkspaceGrants>().covers(&canonical(&root)));
        assert!(!app.fs_scope().is_allowed(&nested));
    }

    /// The asset half matters on its own: without it, a workspace's images
    /// and media never render. A grant the ASSET scope refused is a failed
    /// grant too, and nothing is recorded (audit F2 #88).
    #[test]
    fn a_grant_the_asset_scope_refuses_is_an_error_and_is_not_recorded() {
        let app = mock_app();
        let (_dir, root, nested) = workspace();
        app.asset_protocol_scope()
            .forbid_directory(&root, true)
            .expect("forbid");

        let err = grant_chosen_root(app.handle(), &root).expect_err("media would not render");

        assert_eq!(err.code(), ErrorCode::Internal);
        assert!(!app.state::<WorkspaceGrants>().covers(&canonical(&root)));
        assert!(!app.asset_protocol_scope().is_allowed(&nested));
    }

    #[test]
    fn a_list_this_build_cannot_read_grants_nothing() {
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);
        let (_dir, root, nested) = workspace();
        let forged = serde_json::json!({ "version": 99, "roots": [canonical(&root)] });
        std::fs::write(&file, forged.to_string()).expect("write");

        let app = mock_app();
        restore_from(app.handle(), file.clone(), WAIT);

        assert_eq!(readable(&app, &nested), (false, false));
        assert!(!app.state::<WorkspaceGrants>().covers(&canonical(&root)));

        // And the next choice replaces it with a list this build CAN read.
        grant_chosen_root(app.handle(), &root).expect("grant");
        let bytes = std::fs::read(&file).expect("rewritten");
        assert!(super::super::registry::GrantList::parse(&bytes).is_ok());
    }

    #[test]
    fn the_list_file_is_fenced_off_from_the_fs_plugin() {
        // The static capability scope covers `$HOME/**`, which is where the app
        // data directory lives on macOS and Windows: without this, a script
        // could write its own roots into the list through `writeTextFile`.
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);

        let app = mock_app();
        restore_from(app.handle(), file.clone(), WAIT);

        assert!(app.fs_scope().is_forbidden(&file));
    }
}

// `run_workflow` is bounded by its workspace root, so a root that contains the
// app data folder would let an `action/save-file` step rewrite the list. The
// refusal has to land BEFORE the run claims the engine or spends its id — a
// refused start must leave nothing behind (WI-LX1.1 follow-up). What it left is
// observed through the command itself: a second start with the SAME id must be
// admitted, which it is not if the first claimed the engine (`conflict`) or
// recorded the id (`conflict`, #264).
#[cfg(not(target_os = "windows"))]
mod run_workflow_refuses_the_list_folder {
    use std::collections::HashMap;
    use std::time::Duration;

    use tauri::Manager;

    use super::super::{restore_from, WorkspaceGrants, GRANTS_FILE};
    use crate::command_error::{CommandError, ErrorCode};
    use crate::workflow::commands::{run_workflow, workflow_engine_policy};
    use crate::workflow::state::WorkflowRunnerState;

    const VALID: &str =
        "name: Test\nsteps:\n  - id: say\n    uses: action/notify\n    with:\n      message: hi\n";

    async fn start(
        app: &tauri::App<tauri::test::MockRuntime>,
        root: &std::path::Path,
    ) -> Result<String, CommandError> {
        run_workflow(
            app.handle().clone(),
            VALID.into(),
            HashMap::new(),
            root.to_str().expect("utf-8").to_owned(),
            None,
            Some("run-list".into()),
            None,
            app.state(),
        )
        .await
    }

    #[tokio::test]
    async fn a_root_containing_the_list_is_refused_before_anything_is_claimed() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .manage(WorkspaceGrants::default())
            .manage(WorkflowRunnerState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app");
        workflow_engine_policy(true, app.state())
            .await
            .expect("engine on");
        let data = tempfile::tempdir().expect("app data");
        restore_from(
            app.handle(),
            data.path().join(GRANTS_FILE),
            Duration::from_secs(5),
        );

        let err = start(&app, data.path())
            .await
            .expect_err("the list's folder is not a workspace");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
        assert_eq!(err.i18n_key(), Some("errors.workspaceAccess.listProtected"));

        let elsewhere = tempfile::tempdir().expect("workspace");
        let id = start(&app, elsewhere.path())
            .await
            .expect("the refusal claimed nothing and spent no id");
        assert_eq!(id, "run-list");
    }
}
