//! The authorization decision behind `allow_workspace_access`, on EVERY
//! platform (WI-LX1.1).
//!
//! The command tests need MockRuntime, which dies at startup on
//! windows-latest, so they are gated off the one platform whose static scope
//! stops at `F:\` — where runtime grants matter most. `authorize` takes the
//! grant state and a path, not an app, so the decision runs here against real
//! folders everywhere, Windows drive letters, extended-length spellings and
//! case variants included.
//!
//! LIMITS, stated rather than implied: the `#[cfg(windows)]` cases run only on
//! CI's Windows leg (they are compiled locally by `check-cross-target.sh`, not
//! run). Two Windows behaviours have no unit test at all: the runtime GRANT on
//! Windows (it needs MockRuntime) and a real UNC share (a test machine has
//! none to point at). UNC MATCHING is pinned in `registry.test.rs`.

use std::path::Path;

use super::authorize;
use crate::command_error::{CommandError, ErrorCode};
use crate::workspace::grants::{canonical_dir, WorkspaceGrants};

/// A recorded root with a subfolder, as a user's earlier choice leaves it.
fn chosen() -> (tempfile::TempDir, WorkspaceGrants, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(dir.path().join("root").join("sub")).expect("mkdir");
    let root = canonical_dir(&dir.path().join("root")).expect("a folder");
    let grants = WorkspaceGrants::default();
    grants.record(&root);
    (dir, grants, root)
}

#[test]
fn a_recorded_root_and_a_folder_inside_it_are_authorized_canonically() {
    let (dir, grants, root) = chosen();
    assert_eq!(
        authorize(&grants, Path::new(&root)).expect("recorded"),
        root
    );
    let sub = authorize(&grants, &dir.path().join("root").join("sub")).expect("inside");
    assert_eq!(
        sub,
        canonical_dir(&dir.path().join("root").join("sub")).unwrap()
    );
}

#[test]
fn a_sibling_sharing_the_name_prefix_and_the_parent_are_refused() {
    let (dir, grants, _root) = chosen();
    std::fs::create_dir(dir.path().join("root-evil")).expect("mkdir");
    for path in [dir.path().join("root-evil"), dir.path().to_path_buf()] {
        let err = authorize(&grants, &path).expect_err("not chosen");
        assert_eq!(
            err.code(),
            ErrorCode::PermissionDenied,
            "{}",
            path.display()
        );
    }
}

#[test]
fn a_relative_missing_or_file_path_is_refused_before_the_list_is_asked() {
    let (dir, grants, _root) = chosen();
    std::fs::write(dir.path().join("root").join("note.md"), b"x").expect("write");
    let cases = [
        (Path::new("root/sub").to_path_buf(), ErrorCode::InvalidInput),
        (dir.path().join("root").join("gone"), ErrorCode::NotFound),
        (
            dir.path().join("root").join("note.md"),
            ErrorCode::InvalidInput,
        ),
    ];
    for (path, code) in cases {
        let err = authorize(&grants, &path).expect_err("refused");
        assert_eq!(err.code(), code, "{}", path.display());
    }
}

// -- No oracle (audit F2 #83) -------------------------------------------------
//
// The command is invocable by any script, so a refusal must say nothing about
// the path it refuses: not whether it exists, not whether it is a file, and not
// where a link points. Every path outside the user's chosen folders gets the
// SAME error — built from the caller's own spelling — and differs from any
// other refusal only by that spelling.

fn refused(path: &Path) -> CommandError {
    crate::localized_error!(
        ErrorCode::PermissionDenied,
        "errors.workspaceAccess.notGranted",
        path = path.display()
    )
}

#[test]
fn an_unchosen_path_is_refused_identically_whatever_is_there() {
    let (dir, grants, _root) = chosen();
    let elsewhere = tempfile::tempdir().expect("elsewhere");
    std::fs::create_dir(elsewhere.path().join("folder")).expect("mkdir");
    std::fs::write(elsewhere.path().join("file.md"), b"x").expect("write");
    let cases = [
        elsewhere.path().join("folder"),
        elsewhere.path().join("missing"),
        elsewhere.path().join("file.md"),
        elsewhere.path().join("missing").join("deeper"),
        dir.path().to_path_buf(), // the parent of a chosen root
    ];
    for path in cases {
        let err = authorize(&grants, &path).expect_err("not chosen");
        assert_eq!(err, refused(&path), "{}", path.display());
    }
}

/// A link is judged by where it RESOLVES, but the refusal names only the link:
/// its target is exactly what a script could not otherwise learn.
#[cfg(unix)]
#[test]
fn a_refused_link_does_not_reveal_its_target() {
    let (_dir, grants, _root) = chosen();
    let secret = tempfile::tempdir().expect("secret");
    let target = secret.path().join("hidden-name");
    std::fs::create_dir(&target).expect("mkdir");
    let links = tempfile::tempdir().expect("links");
    let link = links.path().join("probe");
    std::os::unix::fs::symlink(&target, &link).expect("link");

    let err = authorize(&grants, &link).expect_err("not chosen");

    assert_eq!(err, refused(&link));
    assert!(!err.message().contains("hidden-name"), "{}", err.message());
}

/// Inside a chosen folder there is nothing to hide — it is the user's own
/// tree — so a vanished subfolder is still reported as gone, which is what
/// lets Open Recent offer to forget it.
#[test]
fn inside_a_chosen_root_a_missing_folder_is_still_not_found() {
    let (dir, grants, _root) = chosen();
    let gone = dir.path().join("root").join("gone").join("deeper");
    let err = authorize(&grants, &gone).expect_err("absent");
    assert_eq!(err.code(), ErrorCode::NotFound);
}

/// Windows: the extended-length spelling of a recorded root is the same
/// folder. `canonical_dir` resolves it and strips the prefix before the list
/// is asked, so it is authorized — and answered in the recorded spelling.
#[cfg(windows)]
#[test]
fn an_extended_length_spelling_of_a_recorded_root_is_authorized() {
    let (_dir, grants, root) = chosen();
    let verbatim = format!(r"\\?\{root}");
    assert_eq!(
        authorize(&grants, Path::new(&verbatim)).expect("same folder"),
        root
    );
}

/// Windows: a drive-relative spelling (`C:root`) names a folder relative to
/// that drive's current directory, not one folder, and is refused as relative.
#[cfg(windows)]
#[test]
fn a_drive_relative_path_is_refused() {
    let (_dir, grants, root) = chosen();
    let drive_relative = format!("{}{}", &root[..2], "root");
    let err = authorize(&grants, Path::new(&drive_relative)).expect_err("relative");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
}

/// Windows: a differently-CASED spelling of a recorded root is the same folder
/// (NTFS ignores case). `canonicalize` asks the file system for the path as
/// stored (`GetFinalPathNameByHandleW`), so it is authorized and answered in
/// the recorded spelling — never as a second root.
#[cfg(windows)]
#[test]
fn a_case_variant_spelling_of_a_recorded_root_is_authorized_as_recorded() {
    let (dir, grants, root) = chosen();
    let variant = dir.path().join("ROOT").join("SUB");
    let sub = canonical_dir(&dir.path().join("root").join("sub")).expect("a folder");
    assert_eq!(authorize(&grants, &variant).expect("same folder"), sub);
    assert!(sub.starts_with(&root));
}
