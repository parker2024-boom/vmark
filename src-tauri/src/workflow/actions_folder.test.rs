//! Unit tests for `actions_folder.rs`'s pure halves.
//!
//! The folder-read FLOW is exercised through `execute_action` in
//! `actions.test.rs`, against a real temp directory. What lives here is the
//! part that cannot be reached that way: macOS and Windows refuse to CREATE a
//! file whose name is not valid Unicode (APFS answers `EILSEQ`), so the
//! non-UTF-8 label case has no filesystem route on two of three platforms.
//! `OsString` can hold those bytes without a filesystem, which is what makes
//! the property testable everywhere the defect could ship.

use super::*;

/// #508 — two names that differ only in bytes `to_string_lossy` cannot
/// represent must not produce the SAME section label.
///
/// The ORDER was already fixed for exactly this (#255): entries sort by their
/// raw `OsString`, so the two are distinct and stably ordered. The LABEL was
/// not, so the output carried two identical `--- … ---` headers and nothing
/// downstream could say which content came from which file.
#[cfg(unix)]
#[test]
fn two_non_utf8_names_get_distinct_labels() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let one = section_label(&OsStr::from_bytes(b"a\xfe.md").to_os_string());
    let two = section_label(&OsStr::from_bytes(b"a\xff.md").to_os_string());
    assert_ne!(
        one, two,
        "lossy rendering collapses both to one label: {one} / {two}"
    );
    assert!(one.contains("afe") || one.contains("61fe2e6d64"), "{one}");
}

/// A name that IS valid UTF-8 is passed through untouched — every name on
/// macOS and Windows takes this path, so the output format is unchanged for
/// them.
#[test]
fn a_valid_name_is_its_own_label() {
    assert_eq!(
        section_label(&std::ffi::OsString::from("notes.md")),
        "notes.md"
    );
    assert_eq!(
        section_label(&std::ffi::OsString::from("\u{4f60}\u{597d}.md")),
        "\u{4f60}\u{597d}.md"
    );
}

/// #510 — the skipped section names each entry and its reason, so a partial
/// read is visible to the step that consumes the text.
#[test]
fn the_skipped_section_names_every_entry_and_its_reason() {
    let rendered = skipped_section(&[
        SkippedEntry {
            label: "a.bin".into(),
            reason: "not valid UTF-8".into(),
        },
        SkippedEntry {
            label: "b.md".into(),
            reason: "resolves outside the workspace".into(),
        },
    ]);
    assert!(rendered.starts_with("--- skipped (2) ---"), "{rendered}");
    assert!(rendered.contains("a.bin: not valid UTF-8"), "{rendered}");
    assert!(
        rendered.contains("b.md: resolves outside the workspace"),
        "{rendered}"
    );
}

/// WI-RA7C.2 — a file name is the workspace's text, not VMark's. Unix allows a
/// newline in one, and the skip log used to print it raw, so a file could
/// write a log line of its own. (macOS and Linux only: Windows has no such
/// name to create.)
#[cfg(unix)]
#[test]
fn a_skipped_file_name_cannot_forge_a_log_line() {
    let dir = tempfile::tempdir().expect("tempdir");
    let hostile = "a\n[Tauri] window \"main\" destroy result: Ok(()).md";
    // Not valid UTF-8, so the entry is skipped and the skip is logged.
    std::fs::write(dir.path().join(hostile), [0xff, 0xfe, 0xfd]).expect("write");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime");
    let mut read = None;
    let logged = crate::peer_text::log_capture::captured_logs(|| {
        read = Some(runtime.block_on(read_folder(".", dir.path(), &HashMap::new(), dir.path())));
    });
    assert!(read.expect("ran").is_ok());
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(
        logged[0].starts_with("Skipping unreadable file "),
        "{}",
        logged[0]
    );
    assert!(!logged[0].contains('\n'), "{}", logged[0]);
}
