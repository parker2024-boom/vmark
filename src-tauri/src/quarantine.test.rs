//! Tests for `quarantine.rs` (macOS only: the attribute and the strip are).
//!
//! WI-RA4.4 — `strip_workspace_quarantine_cmd` used to strip any folder the
//! webview named. It now strips only a folder the document windows can already
//! read (a granted workspace, or one inside the asset-protocol scope), judged
//! by its canonical path; and a link inside a workspace is never followed to
//! the file it points at.

use super::*;
use std::fs;

use tauri::Manager;

use crate::command_error::ErrorCode;
use crate::workspace::grants::WorkspaceGrants;

fn set_quarantine(path: &Path) {
    // Realistic value matching what the Mixin app writes.
    xattr::set(path, QUARANTINE_ATTR, b"0286;69ef2b4d;Mixin;").unwrap();
}

fn has_quarantine(path: &Path) -> bool {
    matches!(xattr::get(path, QUARANTINE_ATTR), Ok(Some(_)))
}

#[test]
fn strips_root_and_every_supported_extension_child() {
    // WI-1B.16: scope expanded from .md-only to every registered
    // format. Verifies markdown + txt + json + yaml + html now all
    // get cleared, while an unregistered extension (.zip) is left
    // alone.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let md = root.join("a.md");
    let markdown = root.join("b.markdown");
    let txt = root.join("c.txt");
    let json = root.join("d.json");
    let yaml = root.join("e.yaml");
    let html = root.join("f.html");
    let zip = root.join("g.zip");
    for path in [&md, &markdown, &txt, &json, &yaml, &html, &zip] {
        fs::write(path, b"data").unwrap();
        set_quarantine(path);
    }
    set_quarantine(root);

    let stats = strip_workspace_quarantine(root);

    assert_eq!(stats.error_count, 0);
    // Root + 6 supported children = 7. .zip is left alone.
    assert_eq!(stats.stripped_count, 7);
    for path in [&md, &markdown, &txt, &json, &yaml, &html] {
        assert!(!has_quarantine(path), "{} kept attr", path.display());
    }
    assert!(!has_quarantine(root));
    assert!(has_quarantine(&zip), "unregistered .zip should keep attr");
}

#[test]
fn does_not_recurse_into_subdirectories() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let nested = root.join("sub");
    fs::create_dir(&nested).unwrap();
    let nested_md = nested.join("deep.md");
    fs::write(&nested_md, b"# deep").unwrap();
    set_quarantine(&nested_md);

    let stats = strip_workspace_quarantine(root);

    assert_eq!(stats.stripped_count, 0);
    assert_eq!(stats.error_count, 0);
    // Depth-2 file untouched.
    assert!(has_quarantine(&nested_md));
}

#[test]
fn idempotent_on_already_clean_files() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let md = root.join("a.md");
    fs::write(&md, b"# a").unwrap();

    let first = strip_workspace_quarantine(root);
    let second = strip_workspace_quarantine(root);

    assert_eq!(first.stripped_count, 0);
    assert_eq!(first.error_count, 0);
    assert_eq!(second.stripped_count, 0);
    assert_eq!(second.error_count, 0);
}

#[test]
fn missing_root_returns_empty_stats() {
    let stats = strip_workspace_quarantine(Path::new("/no/such/path/we/hope"));
    assert_eq!(stats.stripped_count, 0);
    assert_eq!(stats.error_count, 0);
}

// WI-RA14B.3 — best-effort means counted, never fatal: a root whose entries
// cannot be listed, and a child whose attribute cannot be removed, are each
// one error, and the rest of the pass still runs.
#[test]
fn an_unlistable_root_is_stripped_and_its_listing_counted_as_one_error() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("ws");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("a.md"), b"x").unwrap();
    set_quarantine(&root.join("a.md"));
    set_quarantine(&root);
    // Write + search, no read: the root's own attribute can go, its entries
    // cannot be listed.
    fs::set_permissions(&root, fs::Permissions::from_mode(0o300)).unwrap();

    let stats = strip_workspace_quarantine(&root);
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(stats.stripped_count, 1, "the root itself");
    assert_eq!(stats.error_count, 1, "the listing");
    assert!(!has_quarantine(&root));
    assert!(has_quarantine(&root.join("a.md")), "never reached");
}

#[test]
fn a_child_whose_attribute_cannot_be_removed_is_counted_and_the_rest_continue() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for name in ["a.md", "b.md", "c.md"] {
        fs::write(root.join(name), b"x").unwrap();
        set_quarantine(&root.join(name));
    }
    // An immutable file (`UF_IMMUTABLE`): removing its attribute fails with
    // EPERM. The guard clears the flag on every exit so the temp dir can be
    // removed.
    fn set_flags(path: &Path, flags: libc::c_uint) -> std::io::Result<()> {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        // SAFETY: `c_path` is a NUL-terminated string that outlives the call.
        if unsafe { libc::chflags(c_path.as_ptr(), flags) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    struct Immutable(PathBuf);
    impl Drop for Immutable {
        fn drop(&mut self) {
            let _ = set_flags(&self.0, 0);
        }
    }
    let locked = root.join("b.md");
    set_flags(&locked, libc::UF_IMMUTABLE).expect("chflags");
    let _unlock = Immutable(locked.clone());

    let stats = strip_workspace_quarantine(root);

    assert_eq!(stats.error_count, 1, "the locked file");
    assert_eq!(stats.stripped_count, 2, "the other two");
    assert!(has_quarantine(&locked));
    assert!(!has_quarantine(&root.join("a.md")));
    assert!(!has_quarantine(&root.join("c.md")));
}

#[test]
fn root_pointing_to_file_returns_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("regular.md");
    fs::write(&f, b"# x").unwrap();
    set_quarantine(&f);

    let stats = strip_workspace_quarantine(&f);

    // We never strip when root is not a directory — caller's responsibility
    // to pass a workspace dir, not a single file.
    assert_eq!(stats.stripped_count, 0);
    assert!(has_quarantine(&f));
}

#[test]
fn handles_cjk_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("《定投》");
    fs::create_dir(&root).unwrap();
    let md = root.join("英国老太太.md");
    fs::write(&md, b"# cjk").unwrap();
    set_quarantine(&root);
    set_quarantine(&md);

    let stats = strip_workspace_quarantine(&root);

    assert_eq!(stats.error_count, 0);
    assert_eq!(stats.stripped_count, 2);
    assert!(!has_quarantine(&md));
}

// ── links are not followed ──────────────────────────────────────────────────

/// A link in the workspace that points at a file outside it must not carry
/// the strip to that file: the attribute is removed from the entry itself.
#[test]
fn a_symlink_child_is_not_followed_to_the_file_it_points_at() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("workspace");
    let outside = tmp.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    let target = outside.join("downloaded.md");
    fs::write(&target, b"# quarantined elsewhere").unwrap();
    set_quarantine(&target);
    std::os::unix::fs::symlink(&target, root.join("link.md")).unwrap();
    let own = root.join("own.md");
    fs::write(&own, b"# mine").unwrap();
    set_quarantine(&own);

    let stats = strip_workspace_quarantine(&root);

    assert_eq!(stats.error_count, 0);
    assert_eq!(stats.stripped_count, 1, "only the workspace's own file");
    assert!(!has_quarantine(&own));
    assert!(
        has_quarantine(&target),
        "the strip followed a link out of the workspace"
    );
}

/// The same for a link to a FOLDER: its contents are another folder's.
#[test]
fn a_symlinked_subfolder_is_not_entered() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("workspace");
    let outside = tmp.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    let target = outside.join("note.md");
    fs::write(&target, b"# elsewhere").unwrap();
    set_quarantine(&target);
    set_quarantine(&outside);
    std::os::unix::fs::symlink(&outside, root.join("linked.md")).unwrap();

    let stats = strip_workspace_quarantine(&root);

    assert_eq!(stats.stripped_count, 0);
    assert!(has_quarantine(&target));
    assert!(has_quarantine(&outside));
}

// ── only a folder the document windows can read ─────────────────────────────

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .manage(WorkspaceGrants::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

fn call(
    app: &tauri::App<tauri::test::MockRuntime>,
    root: &Path,
) -> Result<StripStats, CommandError> {
    tauri::async_runtime::block_on(strip_workspace_quarantine_cmd(
        app.handle().clone(),
        root.to_str().expect("utf-8 path").to_owned(),
    ))
}

/// A quarantined folder holding one quarantined `.md`, under a fresh temp
/// directory. Returns the guard, the folder and the file.
fn quarantined_workspace(name: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(name);
    fs::create_dir(&root).unwrap();
    let note = root.join("note.md");
    fs::write(&note, b"# note").unwrap();
    set_quarantine(&root);
    set_quarantine(&note);
    (tmp, root, note)
}

fn grant(app: &tauri::App<tauri::test::MockRuntime>, folder: &Path) {
    let canonical = folder.canonicalize().expect("canonicalize");
    app.state::<WorkspaceGrants>()
        .record(canonical.to_str().expect("utf-8 path"));
}

#[test]
fn a_folder_the_webview_cannot_read_is_refused_and_keeps_its_quarantine() {
    let app = mock_app();
    let (_tmp, root, note) = quarantined_workspace("not-granted");

    let error = call(&app, &root).expect_err("never granted, outside every scope");

    assert_eq!(error.code(), ErrorCode::PermissionDenied);
    assert!(has_quarantine(&root), "the folder was stripped anyway");
    assert!(has_quarantine(&note), "a file in it was stripped anyway");
}

#[test]
fn a_granted_workspace_is_stripped() {
    let app = mock_app();
    let (_tmp, root, note) = quarantined_workspace("《定投》 workspace");
    grant(&app, &root);

    let stats = call(&app, &root).expect("a granted workspace");

    assert_eq!((stats.stripped_count, stats.error_count), (2, 0));
    assert!(!has_quarantine(&root));
    assert!(!has_quarantine(&note));
}

#[test]
fn a_folder_inside_a_granted_workspace_is_stripped() {
    let app = mock_app();
    let (tmp, root, note) = quarantined_workspace("inner");
    grant(&app, tmp.path());

    let stats = call(&app, &root).expect("inside a granted workspace");

    assert_eq!((stats.stripped_count, stats.error_count), (2, 0));
    assert!(!has_quarantine(&note));
}

/// A runtime grant made this session (the recursive workspace grant puts the
/// folder in the asset-protocol scope) is enough, recorded or not.
#[test]
fn a_folder_granted_to_the_asset_scope_at_runtime_is_stripped() {
    let app = mock_app();
    let (tmp, root, note) = quarantined_workspace("in-scope");
    app.asset_protocol_scope()
        .allow_directory(tmp.path().canonicalize().unwrap(), true)
        .expect("allow");

    let stats = call(&app, &root).expect("inside the asset scope");

    assert_eq!((stats.stripped_count, stats.error_count), (2, 0));
    assert!(!has_quarantine(&root));
    assert!(!has_quarantine(&note));
}

/// An app whose CONFIGURED asset-protocol scope is `<base>/**` — the shape of
/// the shipped `$HOME/**`, which `capabilities.test.rs` pins equal to the fs
/// capability's static roots.
fn mock_app_with_static_scope(base: &Path) -> tauri::App<tauri::test::MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().app.security.asset_protocol.scope =
        tauri::utils::config::FsScope::AllowedPaths(vec![base.join("**")]);
    tauri::test::mock_builder()
        .manage(WorkspaceGrants::default())
        .build(context)
        .expect("build mock app")
}

/// The static capability roots reach the command as the configured
/// asset-protocol scope. A workspace under them is opened without ever being
/// "granted" (a file opened from Finder adopts its folder, Open Recent finds
/// it readable), and it must keep being stripped — that is what the feature
/// is for.
#[test]
fn a_folder_under_the_static_scope_is_stripped_without_any_grant() {
    let (tmp, root, note) = quarantined_workspace("under-home");
    let app = mock_app_with_static_scope(&tmp.path().canonicalize().unwrap());

    let stats = call(&app, &root).expect("inside the static scope");

    assert_eq!((stats.stripped_count, stats.error_count), (2, 0));
    assert!(!has_quarantine(&root));
    assert!(!has_quarantine(&note));
}

/// The static scope is not a blanket: a folder outside it is still refused,
/// and so is the scope's own base (`$HOME/**` does not cover `$HOME` itself).
#[test]
fn a_folder_outside_the_static_scope_is_still_refused() {
    let (scope_tmp, _, _) = quarantined_workspace("under-home");
    let base = scope_tmp.path().canonicalize().unwrap();
    let app = mock_app_with_static_scope(&base);
    let (_tmp, outside, outside_note) = quarantined_workspace("elsewhere");
    set_quarantine(&base);

    for refused in [&outside, &base] {
        let error = call(&app, refused).expect_err("outside the static scope");
        assert_eq!(error.code(), ErrorCode::PermissionDenied);
    }
    assert!(has_quarantine(&outside_note));
    assert!(has_quarantine(&base));
}

/// A link inside a granted workspace does not lend its grant to the folder it
/// points at: the canonical folder is what is judged.
#[test]
fn a_link_out_of_a_granted_workspace_is_judged_by_where_it_points() {
    let app = mock_app();
    let (_granted_tmp, granted, _) = quarantined_workspace("granted");
    grant(&app, &granted);
    let (_outside_tmp, outside, outside_note) = quarantined_workspace("outside");
    let escape = granted.join("escape");
    std::os::unix::fs::symlink(&outside, &escape).unwrap();

    let error = call(&app, &escape).expect_err("the link's target was never granted");

    assert_eq!(error.code(), ErrorCode::PermissionDenied);
    assert!(has_quarantine(&outside));
    assert!(has_quarantine(&outside_note));
}

/// No oracle: a path that does not exist is refused exactly like one that
/// exists but is out of reach.
#[test]
fn a_missing_folder_and_an_unreadable_one_are_refused_alike() {
    let app = mock_app();
    let (_tmp, root, _) = quarantined_workspace("exists");
    let missing = root.with_file_name("does-not-exist");

    let unreadable = call(&app, &root).expect_err("out of reach");
    let absent = call(&app, &missing).expect_err("not there");

    assert_eq!(absent.code(), unreadable.code());
    assert_eq!(absent.code(), ErrorCode::PermissionDenied);
}

#[test]
fn a_relative_root_is_invalid_input() {
    let app = mock_app();
    let error = call(&app, Path::new("some/relative/folder")).expect_err("relative");
    assert_eq!(error.code(), ErrorCode::InvalidInput);
}

/// A granted root that is a file, not a folder, is still not stripped — the
/// caller's job is to pass a workspace folder.
#[test]
fn a_granted_file_is_not_stripped() {
    let app = mock_app();
    let (tmp, _, note) = quarantined_workspace("has-a-file");
    grant(&app, tmp.path());

    let stats = call(&app, &note).expect("readable, but not a folder");

    assert_eq!(stats.stripped_count, 0);
    assert!(has_quarantine(&note));
}

// ── the decision, without an app ────────────────────────────────────────────

#[test]
fn the_root_that_is_judged_and_returned_is_the_canonical_one() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let canonical = real.canonicalize().unwrap();

    let judged = std::cell::RefCell::new(Vec::new());
    let root = readable_workspace_root(&link.join("..").join("link"), |folder| {
        judged.borrow_mut().push(folder.to_path_buf());
        true
    })
    .expect("readable");

    assert_eq!(root, canonical);
    assert_eq!(*judged.borrow(), vec![canonical]);
}
