//! Tests for `workspace/grants/protect.rs` — keeping webview-supplied writes,
//! and workflow roots, off the workspace-grant list.
//!
//! WI-LX1.1 — the list decides what is granted at the next launch, so it is
//! matched by identity, by folder and by name, and every resolution failure
//! other than "nothing is there" refuses.

// -- The list refuses webview-supplied writes (WI-LX1.1) ----------------------
//
// `atomic_write_file` writes any absolute path, so without this a script could
// write its own roots into the list and have them granted at the next launch.
// A write lands on the list if its folder is the list's folder (compared after
// resolving links, so an aliased folder is caught) and its name is the list's
// name ignoring ASCII case (macOS and Windows file systems ignore it too).
mod names_grant_list {
    use std::path::Path;

    use super::super::names_grant_list;
    use crate::workspace::grants::GRANTS_FILE;

    fn data() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let list = dir.path().join(GRANTS_FILE);
        (dir, list)
    }

    #[test]
    fn the_list_itself() {
        let (_dir, list) = data();
        assert!(names_grant_list(&list, &list));
    }

    #[test]
    fn a_case_variant_of_its_name() {
        let (dir, list) = data();
        assert!(names_grant_list(
            &list,
            &dir.path().join("WORKSPACE-Grants.JSON")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn its_name_under_a_linked_folder() {
        let (dir, list) = data();
        let elsewhere = tempfile::tempdir().expect("elsewhere");
        let alias = elsewhere.path().join("alias");
        std::os::unix::fs::symlink(dir.path(), &alias).expect("link");
        assert!(names_grant_list(&list, &alias.join(GRANTS_FILE)));
    }

    #[test]
    fn not_its_name_in_another_folder() {
        let (_dir, list) = data();
        let other = tempfile::tempdir().expect("other");
        assert!(!names_grant_list(&list, &other.path().join(GRANTS_FILE)));
    }

    #[test]
    fn not_another_file_beside_it() {
        let (dir, list) = data();
        assert!(!names_grant_list(&list, &dir.path().join("notes.md")));
        assert!(!names_grant_list(
            &list,
            &dir.path().join("workspace-grants.json.bak")
        ));
    }

    #[test]
    fn not_a_path_whose_folder_does_not_exist() {
        // Nothing can be written there, so there is nothing to refuse.
        let (_dir, list) = data();
        assert!(!names_grant_list(
            &list,
            Path::new("/no/such/dir/workspace-grants.json")
        ));
    }

    /// Win32 drops trailing dots and spaces from the last component, so on
    /// Windows each of these opens the list itself. Refusing them elsewhere
    /// costs nothing, like the case rule.
    #[test]
    fn a_win32_alias_of_its_name() {
        let (dir, list) = data();
        for alias in [
            "workspace-grants.json.",
            "workspace-grants.json ",
            "Workspace-Grants.json. .",
        ] {
            assert!(
                names_grant_list(&list, &dir.path().join(alias)),
                "{alias:?}"
            );
        }
    }

    /// NTFS stream syntax: `name::$DATA` IS the file's contents, and
    /// `name:other` a stream stored on it. Win32 opens either through the
    /// list, so both are the list whatever `canonicalize` makes of them — the
    /// name is cut at its first `:` (a character no Windows file name holds).
    #[test]
    fn a_stream_spelling_of_its_name() {
        let (dir, list) = data();
        for alias in [
            "workspace-grants.json::$DATA",
            "WORKSPACE-GRANTS.JSON::$data",
            "workspace-grants.json:hidden",
        ] {
            assert!(
                names_grant_list(&list, &dir.path().join(alias)),
                "{alias:?}"
            );
        }
    }

    /// Any spelling that RESOLVES to the list is the list — on Windows an 8.3
    /// short name (`WORKSP~1.JSO`) or a `::$DATA` stream name; everywhere, a
    /// link. The name check cannot see those; the file's identity can.
    #[cfg(unix)]
    #[test]
    fn a_name_that_resolves_to_the_list() {
        let (_dir, list) = data();
        std::fs::write(&list, b"[]").expect("the list exists");
        let other = tempfile::tempdir().expect("other");
        let link = other.path().join("note.md");
        std::os::unix::fs::symlink(&list, &link).expect("link");
        assert!(names_grant_list(&list, &link));
    }

    /// Fail closed on the IDENTITY check too (audit F2 #92): a target under a
    /// folder that cannot be resolved might be an alias of the list whatever it
    /// is called (an 8.3 name, a stream name), and nothing proved it is not.
    #[cfg(unix)]
    #[test]
    fn a_differently_named_target_that_cannot_be_resolved_is_refused() {
        let (dir, list) = data();
        let locked = super::Locked::new(dir.path().join("locked"));
        if locked.is_bypassed() {
            return; // running as root: search permission cannot be withheld
        }
        assert!(names_grant_list(
            &list,
            &locked.path().join("inner").join("note.md")
        ));
    }

    /// A link loop resolves to no file at all, so it cannot be the list — and
    /// the save reports it as a loop, not as the list.
    #[cfg(unix)]
    #[test]
    fn a_link_loop_is_not_mistaken_for_the_list() {
        let (dir, list) = data();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        std::os::unix::fs::symlink(&b, &a).expect("a -> b");
        std::os::unix::fs::symlink(&a, &b).expect("b -> a");
        assert!(!names_grant_list(&list, &a));
    }

    /// Fail closed: a folder that exists but cannot be resolved is not evidence
    /// the write misses the list. Only "nothing is there" is.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_resolved_is_refused() {
        let (dir, list) = data();
        let locked = super::Locked::new(dir.path().join("locked"));
        if locked.is_bypassed() {
            return; // running as root: search permission cannot be withheld
        }
        let target = locked.path().join("inner").join(GRANTS_FILE);
        assert!(names_grant_list(&list, &target));
    }
}

/// A directory with search permission withheld, restored on drop so the
/// tempdir can be removed. `path()/inner` exists but cannot be resolved.
#[cfg(unix)]
struct Locked(std::path::PathBuf);

#[cfg(unix)]
impl Locked {
    fn new(path: std::path::PathBuf) -> Self {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.join("inner")).expect("mkdir");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }

    /// True when the process can search the directory anyway (root).
    fn is_bypassed(&self) -> bool {
        self.0.join("inner").canonicalize().is_ok()
    }
}

#[cfg(unix)]
impl Drop for Locked {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
    }
}

#[cfg(not(target_os = "windows"))]
mod list_protection {
    use std::time::Duration;

    // Only the macOS assertion reads the fs scope; Linux clippy flags it otherwise.
    #[cfg(target_os = "macos")]
    use tauri_plugin_fs::FsExt;

    use crate::command_error::ErrorCode;
    use crate::workspace::grants::{refuse_list_write, restore_from, WorkspaceGrants, GRANTS_FILE};

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .manage(WorkspaceGrants::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app")
    }

    #[test]
    fn a_write_to_the_list_is_refused_with_a_typed_localized_error() {
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);
        let app = mock_app();
        restore_from(app.handle(), file.clone(), Duration::from_secs(5));

        let err = refuse_list_write(app.handle(), &file).expect_err("the list is Rust's");

        assert_eq!(err.code(), ErrorCode::PermissionDenied);
        assert_eq!(err.i18n_key(), Some("errors.workspaceAccess.listProtected"));
        assert!(refuse_list_write(app.handle(), &data.path().join("notes.md")).is_ok());
    }

    #[test]
    fn launch_creates_a_missing_list_so_the_fence_covers_every_spelling() {
        // The fs-plugin fence is a case-sensitive glob. A file that does not
        // exist is matched as spelled, so `WORKSPACE-GRANTS.JSON` would slip
        // past it and, on a case-insensitive disk, create the list. Once the
        // file exists, a request is canonicalized to its real name first.
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);
        let app = mock_app();

        restore_from(app.handle(), file.clone(), Duration::from_secs(5));

        let bytes = std::fs::read(&file).expect("created at launch");
        assert!(
            crate::workspace::grants::registry::GrantList::parse(&bytes).is_ok(),
            "an empty, valid list"
        );
        #[cfg(target_os = "macos")]
        assert!(app
            .fs_scope()
            .is_forbidden(data.path().join("WORKSPACE-GRANTS.JSON")));
    }

    // -- where the list is, when launch has not said ---------------------------
    //
    // The guard used to read the location from managed state alone, so a
    // registration regression (no `.manage(WorkspaceGrants)`) or a launch that
    // had not run yet switched protection OFF, silently. It now falls back to
    // the app data directory — where the next launch will read the list.

    fn bare_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app")
    }

    fn where_launch_reads<R: tauri::Runtime>(app: &tauri::App<R>) -> std::path::PathBuf {
        crate::app_paths::app_data_dir(app.handle())
            .expect("app data")
            .join(GRANTS_FILE)
    }

    #[test]
    fn without_managed_state_the_list_is_where_launch_will_read_it() {
        let app = bare_app();
        let located = super::super::list_location(app.handle()).expect("an app data directory");
        assert_eq!(located, where_launch_reads(&app));
    }

    #[test]
    fn before_launch_adopts_a_file_the_list_is_where_launch_will_read_it() {
        let app = mock_app();
        let located = super::super::list_location(app.handle()).expect("an app data directory");
        assert_eq!(located, where_launch_reads(&app));
    }

    #[test]
    fn once_launch_adopts_a_file_that_file_is_the_list() {
        let data = tempfile::tempdir().expect("app data");
        let file = data.path().join(GRANTS_FILE);
        let app = mock_app();
        restore_from(app.handle(), file.clone(), Duration::from_secs(5));
        assert_eq!(
            super::super::list_location(app.handle()).expect("adopted"),
            file
        );
    }

    /// The behaviour the fallback buys, observed directly: with nothing
    /// managed, a write naming the real location is refused. The mock app's
    /// data directory is the platform data folder itself (its identifier is
    /// empty); only a machine without one cannot host the list at all.
    #[test]
    fn without_managed_state_a_write_to_the_list_is_still_refused() {
        let app = bare_app();
        let list = where_launch_reads(&app);
        if !list.parent().is_some_and(std::path::Path::is_dir) {
            return; // no data folder here: nothing can be written at the list
        }
        let err = refuse_list_write(app.handle(), &list).expect_err("protected");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
    }
}

// A workflow run's workspace root bounds every `action/*` step, so a root that
// CONTAINS the list's folder would let a `save-file` step rewrite the list
// (WI-LX1.1 follow-up). The run is refused up front instead.
mod root_contains_list {
    use super::super::root_contains_list;
    use crate::workspace::grants::GRANTS_FILE;

    fn data() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data = dir.path().join("app.vmark");
        std::fs::create_dir_all(&app_data).expect("app data");
        let list = app_data.join(GRANTS_FILE);
        (dir, list)
    }

    #[test]
    fn a_root_that_is_the_list_folder_or_above_it_contains_the_list() {
        let (dir, list) = data();
        assert!(root_contains_list(&list, list.parent().unwrap()));
        assert!(root_contains_list(&list, dir.path()));
    }

    #[test]
    fn a_sibling_or_a_folder_inside_app_data_does_not() {
        let (dir, list) = data();
        let sibling = dir.path().join("app.vmark-notes");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(!root_contains_list(&list, &sibling));
        let inner = list.parent().unwrap().join("workspaces");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(!root_contains_list(&list, &inner));
    }

    #[cfg(unix)]
    #[test]
    fn a_root_that_links_to_an_ancestor_of_the_list_contains_it() {
        let (dir, list) = data();
        let link = tempfile::tempdir().unwrap();
        let alias = link.path().join("alias");
        std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
        assert!(root_contains_list(&list, &alias));
    }

    #[test]
    fn a_root_that_does_not_exist_does_not() {
        let (dir, list) = data();
        assert!(!root_contains_list(&list, &dir.path().join("missing")));
    }

    /// Fail closed, as for writes: a root that exists but cannot be resolved
    /// is refused, not assumed to lie elsewhere.
    #[cfg(unix)]
    #[test]
    fn a_root_that_cannot_be_resolved_is_refused() {
        let (dir, list) = data();
        let locked = super::Locked::new(dir.path().join("locked"));
        if locked.is_bypassed() {
            return; // running as root: search permission cannot be withheld
        }
        assert!(root_contains_list(&list, &locked.path().join("inner")));
    }
}
