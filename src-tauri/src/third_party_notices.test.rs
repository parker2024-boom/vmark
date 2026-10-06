//! WI-RA15B.2 — the About pane's "Third-party notices" action resolves the
//! bundled notices file under the resource directory, and reports a missing
//! one as `not-found` instead of opening nothing.

use super::{notices_file_in, NOTICES_RESOURCE};
use crate::command_error::ErrorCode;
use std::fs;

#[test]
fn resolves_the_notices_file_under_the_resource_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join(NOTICES_RESOURCE);
    fs::create_dir_all(file.parent().expect("parent")).expect("mkdir");
    fs::write(&file, "notices").expect("write");

    assert_eq!(notices_file_in(dir.path()).expect("resolves"), file);
}

#[test]
fn a_missing_file_is_not_found_and_names_the_path() {
    let dir = tempfile::tempdir().expect("tempdir");

    let err = notices_file_in(dir.path()).expect_err("missing file must fail");
    assert_eq!(err.code(), ErrorCode::NotFound);
    assert!(
        err.message().contains("THIRD_PARTY_LICENSES.txt"),
        "message should name the file: {}",
        err.message()
    );
}

#[test]
fn a_directory_in_its_place_is_not_the_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join(NOTICES_RESOURCE)).expect("mkdir");

    let err = notices_file_in(dir.path()).expect_err("a directory is not the notices file");
    assert_eq!(err.code(), ErrorCode::NotFound);
}

#[test]
fn resolves_under_a_resource_dir_with_spaces_and_cjk() {
    let root = tempfile::tempdir().expect("tempdir");
    let dir = root.path().join("VMark 应用 Resources");
    let file = dir.join(NOTICES_RESOURCE);
    fs::create_dir_all(file.parent().expect("parent")).expect("mkdir");
    fs::write(&file, "notices").expect("write");

    assert_eq!(notices_file_in(&dir).expect("resolves"), file);
}
