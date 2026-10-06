// WI-RA14B.3 — the directory-descriptor primitives every anchored workflow
// write stands on: what each call refuses, what it forgives, and that a link
// is never followed. `commit.test.rs` and `ensure_dir.test.rs` drive these
// through their callers; this file pins each primitive's own contract, so a
// change to one cannot hide behind a caller that happens not to reach it.

use super::{c_name, Dir};
use std::ffi::{CString, OsStr};
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

/// A canonical temp directory: on macOS `/var` is a link to `/private/var`,
/// and `open_nofollow` (rightly) refuses a path with a link in it.
fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().canonicalize().expect("canonicalize");
    (tmp, path)
}

fn name(s: &str) -> CString {
    c_name(OsStr::new(s)).expect("name")
}

#[test]
fn open_refuses_a_regular_file_and_a_missing_path() {
    let (_tmp, root) = canonical_tempdir();
    fs::write(root.join("f.md"), "x").expect("write");

    let err = Dir::open(&root.join("f.md"))
        .err()
        .expect("a file is not a directory");
    assert!(err.ends_with("is not a directory"), "{err}");
    let err = Dir::open(&root.join("missing")).err().expect("missing");
    assert!(err.starts_with("cannot open "), "{err}");
}

#[test]
fn open_nofollow_holds_the_same_directory_as_a_plain_open() {
    let (_tmp, root) = canonical_tempdir();
    fs::create_dir_all(root.join("a").join("b")).expect("mkdir");
    let target = root.join("a").join("b");

    let held = Dir::open_nofollow(&target).expect("canonical path opens");

    assert_eq!(
        held.id().expect("id"),
        Dir::open(&target).expect("open").id().expect("id")
    );
}

#[test]
fn open_nofollow_refuses_a_link_at_any_component() {
    let (_tmp, root) = canonical_tempdir();
    fs::create_dir_all(root.join("real").join("inner")).expect("mkdir");
    symlink(root.join("real"), root.join("link")).expect("symlink");

    // A link as the last component, and a link in the middle of the path.
    assert!(Dir::open_nofollow(&root.join("link")).is_err());
    assert!(Dir::open_nofollow(&root.join("link").join("inner")).is_err());
    // The real directory behind it still opens.
    assert!(Dir::open_nofollow(&root.join("real").join("inner")).is_ok());
}

#[test]
fn open_nofollow_refuses_a_path_that_is_not_canonical() {
    let (_tmp, root) = canonical_tempdir();
    fs::create_dir(root.join("a")).expect("mkdir");

    let dotdot = root.join("a").join("..").join("a");
    let err = Dir::open_nofollow(&dotdot).err().expect("`..` is refused");
    assert!(err.ends_with("is not a canonical path"), "{err}");
    let dot = root.join(".").join("a");
    // `Path::components` drops interior `.` — that spelling names the same
    // directory, so it is not a canonicity hazard and opens.
    assert!(Dir::open_nofollow(&dot).is_ok());
}

#[test]
fn open_nofollow_refuses_a_relative_path_instead_of_reading_it_from_the_root() {
    // The walk starts at `/`. A relative path is not canonical: it must be
    // refused, never silently re-read as an absolute one.
    let err = Dir::open_nofollow(Path::new("usr"))
        .err()
        .expect("a relative path is refused");
    assert!(err.ends_with("is not a canonical path"), "{err}");
}

#[test]
fn open_child_refuses_a_symlinked_directory_and_a_file() {
    let (_tmp, root) = canonical_tempdir();
    let outside = tempfile::tempdir().expect("outside");
    fs::create_dir(root.join("sub")).expect("mkdir");
    fs::write(root.join("file.md"), "x").expect("write");
    symlink(outside.path(), root.join("escape")).expect("symlink");
    let dir = Dir::open(&root).expect("open");

    assert!(dir.open_child(&name("sub")).is_ok());
    let err = dir.open_child(&name("escape")).err().expect("link refused");
    assert!(err.contains("inside the workspace"), "{err}");
    assert!(dir.open_child(&name("file.md")).is_err());
    assert!(dir.open_child(&name("missing")).is_err());
}

#[test]
fn parent_climbs_the_real_tree_even_through_a_link() {
    let (_tmp, root) = canonical_tempdir();
    let elsewhere = canonical_tempdir();
    fs::create_dir(elsewhere.1.join("deep")).expect("mkdir");
    symlink(elsewhere.1.join("deep"), root.join("via")).expect("symlink");

    // Opened THROUGH the link (plain `open` follows it), the descriptor
    // still names the real directory, so `..` is the real parent — not the
    // folder the link sits in.
    let through = Dir::open(&root.join("via")).expect("open");
    let up = through.parent().expect("parent");

    assert_eq!(
        up.id().unwrap(),
        Dir::open(&elsewhere.1).unwrap().id().unwrap()
    );
    assert_ne!(up.id().unwrap(), Dir::open(&root).unwrap().id().unwrap());
}

#[test]
fn mkdir_creates_once_and_forgives_an_existing_entry() {
    let (_tmp, root) = canonical_tempdir();
    let dir = Dir::open(&root).expect("open");

    dir.mkdir(&name("new")).expect("create");
    assert!(root.join("new").is_dir());
    dir.mkdir(&name("new"))
        .expect("an existing entry is not an error");
    // An existing FILE is forgiven too — the caller proves what it is with
    // `open_child`, which refuses it.
    fs::write(root.join("file"), "x").expect("write");
    dir.mkdir(&name("file")).expect("forgiven");
    assert!(dir.open_child(&name("file")).is_err());
}

#[test]
fn mkdir_reports_a_failure_that_is_not_an_existing_entry() {
    let (_tmp, root) = canonical_tempdir();
    let dir = Dir::open(&root).expect("open");

    let err = dir
        .mkdir(&name("missing-parent/child"))
        .expect_err("ENOENT is a failure");
    assert!(err.starts_with("cannot create "), "{err}");
}

#[test]
fn holds_tells_the_entry_from_another_file_and_from_nothing() {
    let (_tmp, root) = canonical_tempdir();
    fs::write(root.join("a"), "a").expect("write");
    fs::write(root.join("b"), "b").expect("write");
    symlink(root.join("a"), root.join("link-to-a")).expect("symlink");
    let dir = Dir::open(&root).expect("open");
    let a = fs::File::open(root.join("a")).expect("open a");

    assert!(dir.holds(&name("a"), &a).expect("a"));
    assert!(!dir.holds(&name("b"), &a).expect("b is another file"));
    assert!(!dir.holds(&name("missing"), &a).expect("nothing there"));
    // The link is looked at itself, not followed to `a`.
    assert!(!dir.holds(&name("link-to-a"), &a).expect("not followed"));
}

#[test]
fn holds_reports_a_stat_failure_instead_of_answering_no() {
    let (_tmp, root) = canonical_tempdir();
    fs::write(root.join("a"), "a").expect("write");
    let dir = Dir::open(&root).expect("open");
    let a = fs::File::open(root.join("a")).expect("open a");

    // `a/x` asks fstatat to descend through a regular file: ENOTDIR, which
    // is not "nothing is there" and must not read as a containment refusal.
    let err = dir
        .holds(&name("a/x"), &a)
        .expect_err("ENOTDIR is an error");
    assert!(err.starts_with("cannot stat "), "{err}");
}

#[test]
fn is_regular_file_does_not_follow_a_link() {
    let (_tmp, root) = canonical_tempdir();
    fs::write(root.join("file"), "x").expect("write");
    fs::create_dir(root.join("dir")).expect("mkdir");
    symlink(root.join("file"), root.join("link")).expect("symlink");
    let dir = Dir::open(&root).expect("open");

    assert_eq!(dir.is_regular_file(&name("file")).unwrap(), Some(true));
    assert_eq!(dir.is_regular_file(&name("dir")).unwrap(), Some(false));
    assert_eq!(dir.is_regular_file(&name("link")).unwrap(), Some(false));
    assert_eq!(dir.is_regular_file(&name("missing")).unwrap(), None);
    assert!(dir.is_regular_file(&name("file/x")).is_err());
}

#[test]
fn rename_replaces_the_target_inside_the_held_directory() {
    let (_tmp, root) = canonical_tempdir();
    fs::write(root.join("tmp"), "new").expect("write");
    fs::write(root.join("doc.md"), "old").expect("write");
    let dir = Dir::open(&root).expect("open");

    dir.rename(&name("tmp"), &name("doc.md")).expect("rename");
    dir.sync();

    assert_eq!(fs::read_to_string(root.join("doc.md")).unwrap(), "new");
    assert!(!root.join("tmp").exists());
    let err = dir.rename(&name("tmp"), &name("doc.md")).expect_err("gone");
    assert!(err.starts_with("rename failed"), "{err}");
    assert_eq!(fs::read_to_string(root.join("doc.md")).unwrap(), "new");
}

#[test]
fn unlink_removes_an_entry_and_forgives_one_already_gone() {
    let (_tmp, root) = canonical_tempdir();
    fs::write(root.join("tmp"), "x").expect("write");
    fs::create_dir(root.join("dir")).expect("mkdir");
    let dir = Dir::open(&root).expect("open");

    dir.unlink(&name("tmp")).expect("remove");
    assert!(!root.join("tmp").exists());
    dir.unlink(&name("tmp"))
        .expect("already gone is the end state");
    // A directory is not unlinked by `unlinkat(.., 0)`: reported, kept.
    let err = dir.unlink(&name("dir")).expect_err("EISDIR/EPERM");
    assert!(err.starts_with("cannot remove "), "{err}");
    assert!(root.join("dir").is_dir());
}

#[test]
fn unlink_removes_a_link_and_never_its_target() {
    let (_tmp, root) = canonical_tempdir();
    let outside = tempfile::tempdir().expect("outside");
    let target = outside.path().join("precious.md");
    fs::write(&target, "keep").expect("write");
    symlink(&target, root.join("link")).expect("symlink");
    let dir = Dir::open(&root).expect("open");

    dir.unlink(&name("link")).expect("remove link");

    assert!(fs::symlink_metadata(root.join("link")).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
}

#[test]
fn assert_within_accepts_the_root_and_its_descendants() {
    let (_tmp, root) = canonical_tempdir();
    fs::create_dir_all(root.join("a").join("b")).expect("mkdir");
    let ws = Dir::open(&root).expect("open");

    ws.assert_within(&ws, &root)
        .expect("the root is within itself");
    Dir::open(&root.join("a").join("b"))
        .unwrap()
        .assert_within(&ws, Path::new("a/b"))
        .expect("descendant");
}

#[test]
fn assert_within_refuses_a_sibling_and_a_link_out_of_the_workspace() {
    let (_tmp, parent) = canonical_tempdir();
    fs::create_dir(parent.join("ws")).expect("mkdir");
    fs::create_dir(parent.join("sibling")).expect("mkdir");
    symlink(parent.join("sibling"), parent.join("ws").join("escape")).expect("symlink");
    let ws = Dir::open(&parent.join("ws")).expect("open");

    let err = Dir::open(&parent.join("sibling"))
        .unwrap()
        .assert_within(&ws, Path::new("sibling"))
        .expect_err("sibling is outside");
    assert_eq!(err, "sibling resolves outside the workspace");
    // Through the link the NAME is inside the workspace; the directory held
    // is not, and the walk judges the directory.
    let err = Dir::open(&parent.join("ws").join("escape"))
        .unwrap()
        .assert_within(&ws, Path::new("escape"))
        .expect_err("link target is outside");
    assert_eq!(err, "escape resolves outside the workspace");
}

#[test]
fn c_name_refuses_an_interior_nul() {
    let err = c_name(OsStr::new("a\u{0}b")).expect_err("NUL refused");
    assert!(err.ends_with("is not a usable file name"), "{err}");
    assert_eq!(
        c_name(OsStr::new("文档.md")).unwrap().as_bytes(),
        "文档.md".as_bytes()
    );
}

#[test]
fn try_clone_holds_the_same_directory() {
    let (_tmp, root) = canonical_tempdir();
    let dir = Dir::open(&root).expect("open");
    let clone = dir.try_clone().expect("clone");
    assert_eq!(dir.id().unwrap(), clone.id().unwrap());
    assert_ne!(dir.fd(), clone.fd());
}
