// WI-RA11.5 — workspace config reads and writes run on the blocking pool,
// one at a time, and still read, migrate and write what they did inline.

use super::*;

/// The config locations for `root` inside an app-data stand-in `dir`.
fn paths_in(dir: &Path, root: &str) -> ConfigPaths {
    let ws_dir = dir.join("workspaces");
    ConfigPaths {
        ws_path: ws_dir.join(format!("{}.json", hash_root_path(root))),
        legacy_path: Some(ws_dir.join(format!("{}.json", legacy_hash_root_path(root)))),
        ws_dir,
    }
}

fn json(config: &WorkspaceConfig) -> serde_json::Value {
    serde_json::to_value(config).unwrap()
}

#[test]
fn a_workspace_with_no_config_anywhere_reads_none() {
    let app_data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let root = root.path().to_str().unwrap();

    assert!(read_config_in(&paths_in(app_data.path(), root), root)
        .unwrap()
        .is_none());
}

#[test]
fn a_written_config_reads_back_identically() {
    let app_data = tempfile::tempdir().unwrap();
    let root = "/工作区/notes";
    let paths = paths_in(app_data.path(), root);
    let config = WorkspaceConfig {
        exclude_folders: vec!["build".into(), "草稿".into()],
        last_open_tabs: vec!["/工作区/notes/a.md".into()],
        ..WorkspaceConfig::default()
    };

    write_config_in(&paths, &config).unwrap();
    let read = read_config_in(&paths, root)
        .unwrap()
        .expect("written config");

    assert_eq!(json(&read), json(&config));
}

#[test]
fn a_legacy_workspace_is_migrated_once_and_then_read_from_app_data() {
    let app_data = tempfile::tempdir().unwrap();
    let root_dir = tempfile::tempdir().unwrap();
    let root = root_dir.path().to_str().unwrap();
    std::fs::create_dir(root_dir.path().join(".vmark")).unwrap();
    std::fs::write(
        root_dir.path().join(".vmark/vmark.code-workspace"),
        r#"{ "settings": { "vmark.excludeFolders": ["dist", ".vmark"], "vmark.showHiddenFiles": true } }"#,
    )
    .unwrap();
    let paths = paths_in(app_data.path(), root);

    let first = read_config_in(&paths, root).unwrap().expect("migrated");
    assert_eq!(first.exclude_folders, vec!["dist".to_string()]);
    assert!(first.show_hidden_files);
    assert!(paths.ws_path.exists(), "the migrated config is persisted");
    assert!(
        !root_dir.path().join(".vmark").exists(),
        "the legacy directory is retired once the new file is written"
    );

    // What a second window opening the same workspace reads.
    let second = read_config_in(&paths, root).unwrap().expect("still there");
    assert_eq!(json(&second), json(&first));
}

// `tauri::test::MockRuntime` does not exist on Windows (Cargo.toml scopes the
// `test` feature off it), so these are gated like every mock-runtime suite.
#[cfg(not(target_os = "windows"))]
mod on_a_mock_app {
    use super::super::*;
    use crate::command_error::ErrorCode;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app")
    }

    fn single_worker() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn config_work_runs_off_the_awaiting_thread_and_under_the_lock() {
        let app = mock_app();
        let handle = app.handle().clone();
        let caller = std::thread::current().id();

        let (worker, held) = single_worker()
            .block_on(config_io(app.handle().clone(), move || {
                // Taken by this very task, so a second attempt must fail.
                let held = handle.state::<ConfigIoLock>().0.try_lock().is_err();
                Ok((std::thread::current().id(), held))
            }))
            .unwrap();

        assert_ne!(
            worker, caller,
            "config I/O must not run on the awaiting thread"
        );
        assert!(held, "config I/O must run under the config lock");
        // And the lock is free again afterwards.
        assert!(app.handle().state::<ConfigIoLock>().0.try_lock().is_ok());
    }

    #[test]
    fn a_failure_in_the_work_is_an_io_error() {
        let app = mock_app();
        let error = single_worker()
            .block_on(config_io::<_, (), _>(app.handle().clone(), || {
                Err("Failed to read config: disk on fire".to_string())
            }))
            .expect_err("the work failed");
        assert_eq!(error.code(), ErrorCode::Io);
        assert!(error.message().contains("disk on fire"));
    }
}
