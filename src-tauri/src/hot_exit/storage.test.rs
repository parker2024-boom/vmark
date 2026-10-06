// WI-RA14B.3 — the hot-exit session write is crash-safe: the new session lands
// whole, the previous one is rotated into the backup, and a write that fails
// at any step leaves the session that was on disk readable and no temp file
// behind. Driven through the path-based core so no app handle is needed.

use super::write_session_files;
use std::fs;
use std::path::{Path, PathBuf};

fn paths(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join("session.json"), dir.join("session.prev.json"))
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read_dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_first_write_creates_the_session_and_no_backup() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (session, backup) = paths(tmp.path());

    write_session_files(&session, &backup, r#"{"v":1}"#).expect("write");

    assert_eq!(fs::read_to_string(&session).unwrap(), r#"{"v":1}"#);
    assert!(!backup.exists());
    assert_eq!(names(tmp.path()), vec!["session.json"], "no temp file left");
}

#[test]
fn each_write_rotates_the_previous_session_into_the_backup() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (session, backup) = paths(tmp.path());

    write_session_files(&session, &backup, "one").expect("one");
    write_session_files(&session, &backup, "two").expect("two");
    write_session_files(&session, &backup, "三 — three").expect("three");

    assert_eq!(fs::read_to_string(&session).unwrap(), "三 — three");
    assert_eq!(fs::read_to_string(&backup).unwrap(), "two");
    assert_eq!(names(tmp.path()), vec!["session.json", "session.prev.json"]);
}

#[test]
fn an_unreadable_session_fails_the_write_and_is_not_replaced() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (session, backup) = paths(tmp.path());
    // A folder where the session should be: reading it fails with something
    // other than NotFound, so the rotation cannot run and nothing is renamed.
    fs::create_dir(&session).expect("mkdir");
    fs::write(session.join("keep"), "x").expect("write");

    let err = write_session_files(&session, &backup, "new").expect_err("fails");

    assert!(
        err.starts_with("Failed to read session for backup"),
        "{err}"
    );
    assert!(session.join("keep").is_file());
    assert_eq!(names(tmp.path()), vec!["session.json"], "temp file removed");
}

#[test]
fn a_backup_that_cannot_be_replaced_keeps_the_old_session_in_place() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (session, backup) = paths(tmp.path());
    write_session_files(&session, &backup, "old").expect("old");
    // A non-empty folder at the backup path: persisting the backup fails.
    fs::create_dir(&backup).expect("mkdir");
    fs::write(backup.join("keep"), "x").expect("write");

    let err = write_session_files(&session, &backup, "new").expect_err("fails");

    assert!(err.starts_with("Failed to persist backup"), "{err}");
    assert_eq!(
        fs::read_to_string(&session).unwrap(),
        "old",
        "old session kept"
    );
    assert_eq!(
        names(tmp.path()),
        vec!["session.json", "session.prev.json"],
        "both temp files removed"
    );
}

#[test]
fn a_missing_session_folder_fails_before_anything_is_written() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (_, backup) = paths(tmp.path());
    // The session path's folder does not exist: the temp file cannot be made.
    let session = tmp.path().join("missing").join("session.json");

    let err = write_session_files(&session, &backup, "new").expect_err("fails");

    assert!(err.starts_with("Failed to create temp file"), "{err}");
    assert!(names(tmp.path()).is_empty());
}

#[test]
fn an_empty_payload_is_written_as_an_empty_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (session, backup) = paths(tmp.path());
    fs::write(&session, "previous").expect("write");

    write_session_files(&session, &backup, "").expect("write");

    assert_eq!(fs::read(&session).unwrap(), b"");
    assert_eq!(fs::read_to_string(&backup).unwrap(), "previous");
}
