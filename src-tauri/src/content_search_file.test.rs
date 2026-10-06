// WI-RA11.3 — the per-file scan: one open, the size taken from that handle,
// binary before size, and a read that never exceeds the limit.

use super::super::matching::build_regex;
use super::*;
use std::fs;
use std::time::{Duration, Instant};
use tempfile::tempdir;

fn probe() -> Regex {
    build_regex("probe", false, false, false).unwrap()
}

fn generous() -> DeadlineBudget {
    DeadlineBudget::until(Instant::now() + Duration::from_secs(60))
}

fn spent() -> DeadlineBudget {
    DeadlineBudget::until(Instant::now() - Duration::from_secs(1))
}

/// Scan `contents` as a file on disk with a generous budget and no prior matches.
fn scan(contents: &[u8]) -> FileScan {
    let dir = tempdir().unwrap();
    let path = dir.path().join("subject.md");
    fs::write(&path, contents).unwrap();
    scan_file(&path, &probe(), &generous(), &mut 0)
}

fn line_numbers(scan: &FileScan) -> Vec<u32> {
    match scan {
        FileScan::Scanned { matches, .. } => matches.iter().map(|m| m.line_number).collect(),
        other => panic!("expected a scanned file, got {other:?}"),
    }
}

#[test]
fn a_text_file_is_scanned_to_its_last_line() {
    let scan = scan("first\nthe probe\n\n世界 probe 🌍\nlast probe".as_bytes());
    assert_eq!(line_numbers(&scan), vec![2, 4, 5]);
    assert!(matches!(scan, FileScan::Scanned { finished: true, .. }));
}

#[test]
fn an_empty_file_is_scanned_and_has_no_matches() {
    let scan = scan(b"");
    assert!(line_numbers(&scan).is_empty());
    assert!(matches!(scan, FileScan::Scanned { finished: true, .. }));
}

#[test]
fn crlf_line_endings_do_not_shift_line_numbers() {
    assert_eq!(
        line_numbers(&scan(b"a\r\nprobe\r\nb\r\nprobe\r\n")),
        vec![2, 4]
    );
}

/// The scan never goes back to the path: unlink the file after opening it and
/// every path-based call (a second open, a `stat`) would fail.
#[cfg(unix)]
#[test]
fn a_file_is_read_and_measured_through_the_handle_it_was_opened_with() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("unlinked.md");
    fs::write(&path, "the probe is here\n").unwrap();
    let mut file = File::open(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(!path.exists());

    let scan = scan_open_file(&mut file, &path, &probe(), &generous(), &mut 0);

    assert_eq!(line_numbers(&scan), vec![1]);
}

/// A path that is swapped for another file after the open does not change
/// which file is judged and read.
#[cfg(unix)]
#[test]
fn a_path_replaced_after_the_open_does_not_change_the_file_scanned() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("swapped.md");
    fs::write(&path, "the probe is in the original\n").unwrap();
    let mut file = File::open(&path).unwrap();
    // Replace the path with an oversized binary: by path it is now neither
    // small nor text.
    let replacement = dir.path().join("replacement");
    fs::write(&replacement, vec![0u8; (MAX_FILE_SIZE + 1) as usize]).unwrap();
    fs::rename(&replacement, &path).unwrap();

    let scan = scan_open_file(&mut file, &path, &probe(), &generous(), &mut 0);

    assert_eq!(line_numbers(&scan), vec![1]);
}

#[test]
fn a_binary_file_is_excluded_by_design() {
    assert!(matches!(scan(b"probe\0binary"), FileScan::Excluded));
}

#[test]
fn a_binary_file_is_excluded_however_large_it_is() {
    // Binary is decided before size: an oversized image is not "an eligible
    // file that went unscanned", and must not void completeness.
    let mut bytes = vec![0u8; 16];
    bytes.resize(16 + (MAX_FILE_SIZE + 1) as usize, b'a');
    assert!(matches!(scan(&bytes), FileScan::Excluded));
}

#[test]
fn a_nul_beyond_the_probed_head_does_not_make_a_file_binary() {
    let mut bytes = vec![b'a'; BINARY_CHECK_LEN];
    bytes.extend_from_slice(b"\n\0 probe\n");
    assert_eq!(line_numbers(&scan(&bytes)), vec![2]);
}

#[test]
fn a_file_at_the_size_limit_is_scanned_and_one_byte_over_is_not() {
    let mut at_limit = b"probe\n".to_vec();
    at_limit.resize(MAX_FILE_SIZE as usize, b'a');
    assert_eq!(line_numbers(&scan(&at_limit)), vec![1]);

    let mut over = at_limit;
    over.push(b'a');
    assert!(matches!(scan(&over), FileScan::Unscanned));
}

#[test]
fn a_file_that_is_not_utf8_is_unscanned() {
    assert!(matches!(
        scan(&[0xFF, 0xFE, b'p', b'r', b'o', b'b', b'e']),
        FileScan::Unscanned
    ));
}

#[test]
fn a_spent_budget_stops_before_the_read() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("subject.md");
    fs::write(&path, "probe\n").unwrap();
    assert!(matches!(
        scan_file(&path, &probe(), &spent(), &mut 0),
        FileScan::OutOfTime
    ));
}

#[test]
fn a_binary_file_is_still_excluded_under_a_spent_budget() {
    // Exclusion is decided on the head already in hand; it is not "ran out
    // of time", which would void completeness.
    let dir = tempdir().unwrap();
    let path = dir.path().join("blob.bin");
    fs::write(&path, b"\0\0\0").unwrap();
    assert!(matches!(
        scan_file(&path, &probe(), &spent(), &mut 0),
        FileScan::Excluded
    ));
}

/// A file the process may not open is not "binary". It is an eligible file
/// whose content nobody looked at, and a caller asking "does anything still
/// reference this image?" must not be told the scan saw everything.
#[cfg(unix)]
#[test]
fn a_file_that_cannot_be_opened_is_unscanned_not_excluded() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let path = dir.path().join("locked.md");
    fs::write(&path, "![](image.png) probe\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    // A privileged user can open any file; there is nothing to pin then.
    if File::open(&path).is_ok() {
        return;
    }

    assert!(matches!(
        scan_file(&path, &probe(), &generous(), &mut 0),
        FileScan::Unscanned
    ));
}

#[test]
fn a_file_that_is_gone_by_the_time_it_is_opened_is_unscanned() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("vanished.md");
    assert!(matches!(
        scan_file(&path, &probe(), &generous(), &mut 0),
        FileScan::Unscanned
    ));
}

#[test]
fn the_match_cap_stops_the_line_scan_and_reports_it_unfinished() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("many.md");
    fs::write(&path, "probe\n".repeat(5)).unwrap();
    let mut total = MAX_MATCHES - 2;

    let scan = scan_file(&path, &probe(), &generous(), &mut total);

    assert_eq!(line_numbers(&scan), vec![1, 2]);
    assert!(matches!(
        scan,
        FileScan::Scanned {
            finished: false,
            ..
        }
    ));
    assert_eq!(total, MAX_MATCHES);
}

#[test]
fn a_line_with_more_ranges_than_the_cap_allows_is_truncated_to_it() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("dense.md");
    fs::write(&path, "probe probe probe probe\n").unwrap();
    let mut total = MAX_MATCHES - 3;

    let scan = scan_file(&path, &probe(), &generous(), &mut total);

    match scan {
        FileScan::Scanned { matches, finished } => {
            assert_eq!(matches[0].match_ranges.len(), 3);
            // The only line was looked at: nothing is left unscanned.
            assert!(finished);
        }
        other => panic!("expected a scanned file, got {other:?}"),
    }
    assert_eq!(total, MAX_MATCHES);
}

#[test]
fn a_file_already_at_the_cap_scans_no_line() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("late.md");
    fs::write(&path, "probe\n").unwrap();
    let mut total = MAX_MATCHES;

    let scan = scan_file(&path, &probe(), &generous(), &mut total);

    assert!(line_numbers(&scan).is_empty());
    assert!(matches!(
        scan,
        FileScan::Scanned {
            finished: false,
            ..
        }
    ));
}
