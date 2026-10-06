// WI-RA11.2 — the atomic publication is durable: after the rename swaps the
// new file in, the parent directory is synced, so a crash cannot come back
// with the old directory entry.

use super::*;
use std::cell::RefCell;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tempfile::tempdir;

/// A temp file in `dir` holding `contents`, as a writer hands it over.
fn staged(dir: &Path, contents: &[u8]) -> NamedTempFile {
    let mut temp = NamedTempFile::new_in(dir).unwrap();
    temp.write_all(contents).unwrap();
    temp
}

#[test]
fn the_parent_directory_is_synced_after_the_rename() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("config.json");
    fs::write(&target, "old").unwrap();
    let synced: RefCell<Vec<(PathBuf, String)>> = RefCell::new(Vec::new());

    persist_durably(staged(dir.path(), b"new"), &target, |parent| {
        // Read at the moment of the sync: the rename must already have happened.
        let on_disk = fs::read_to_string(&target).unwrap();
        synced.borrow_mut().push((parent.to_path_buf(), on_disk));
        Ok(())
    })
    .unwrap();

    assert_eq!(
        synced.into_inner(),
        vec![(dir.path().to_path_buf(), "new".to_string())],
        "exactly one sync, of the parent, after the new content is in place"
    );
}

#[test]
fn a_first_write_syncs_the_directory_that_gains_the_entry() {
    // No previous file: without the directory sync a crash leaves NO file.
    let dir = tempdir().unwrap();
    let nested = dir.path().join("笔记");
    fs::create_dir(&nested).unwrap();
    let target = nested.join("mcp-port");
    let synced: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());

    persist_durably(staged(&nested, b"49152"), &target, |parent| {
        synced.borrow_mut().push(parent.to_path_buf());
        Ok(())
    })
    .unwrap();

    assert_eq!(synced.into_inner(), vec![nested]);
    assert_eq!(fs::read_to_string(&target).unwrap(), "49152");
}

#[test]
fn a_failed_rename_syncs_nothing() {
    let dir = tempdir().unwrap();
    // A directory at the target path makes the rename fail.
    let target = dir.path().join("occupied");
    fs::create_dir(&target).unwrap();
    let synced = RefCell::new(0_u32);

    let error = persist_durably(staged(dir.path(), b"x"), &target, |_| {
        *synced.borrow_mut() += 1;
        Ok(())
    })
    .expect_err("renaming over a directory must fail");

    assert!(matches!(error, AtomicReplaceError::Persist(_)));
    assert_eq!(
        synced.into_inner(),
        0,
        "nothing was published, nothing to make durable"
    );
}

#[test]
fn a_directory_sync_failure_does_not_fail_the_write() {
    // The new file is already in place; calling the write failed would be
    // false, and the caller would act on it.
    let dir = tempdir().unwrap();
    let target = dir.path().join("config.json");

    persist_durably(staged(dir.path(), b"new"), &target, |_| {
        Err(std::io::Error::other(
            "this filesystem cannot sync a directory",
        ))
    })
    .expect("the write itself succeeded");

    assert_eq!(fs::read_to_string(&target).unwrap(), "new");
}

#[test]
fn the_synced_directory_is_the_one_holding_the_target() {
    assert_eq!(
        parent_directory(Path::new("/a/b/file.json")),
        Path::new("/a/b")
    );
    assert_eq!(
        parent_directory(Path::new("rel/file.json")),
        Path::new("rel")
    );
    // A bare name has an empty parent; that names the current directory.
    assert_eq!(parent_directory(Path::new("file.json")), Path::new("."));
    // The filesystem root has no parent.
    assert_eq!(parent_directory(Path::new("/")), Path::new("."));
}

#[cfg(unix)]
#[test]
fn a_real_directory_can_be_synced_and_a_missing_one_reports_it() {
    let dir = tempdir().unwrap();
    sync_directory(dir.path()).expect("a real directory syncs");

    let error = sync_directory(&dir.path().join("gone")).expect_err("no such directory");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
}

#[cfg(unix)]
#[test]
fn publishing_through_the_public_entry_point_syncs_the_parent() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("config.json");
    SYNCED_DIRECTORIES.with(|synced| synced.borrow_mut().clear());

    persist_with_retry(staged(dir.path(), b"new"), &target).unwrap();

    let synced = SYNCED_DIRECTORIES.with(|synced| synced.borrow().clone());
    assert_eq!(synced, vec![dir.path().to_path_buf()]);
}
