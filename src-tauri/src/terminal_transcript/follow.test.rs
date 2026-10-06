// WI-RA6.5 — a poll is answered with the whole records appended since the
//   cursor it carries; a file that is not provably the same one, only grown,
//   is answered with a fresh bounded tail. No record and no UTF-8 sequence is
//   ever split.

use super::*;
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

const ROOMY: u64 = 1024;

struct Transcript {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Transcript {
    fn new(content: &[u8]) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("会话 transcript.jsonl");
        std::fs::write(&path, content).expect("write transcript");
        Self { _dir: dir, path }
    }

    fn append(&self, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .expect("open for append");
        file.write_all(bytes).expect("append");
    }

    /// Replace the content through the same inode, as a writer that truncates
    /// and rewrites does.
    fn rewrite(&self, bytes: &[u8]) {
        std::fs::write(&self.path, bytes).expect("rewrite");
    }

    fn read(&self, previous: Option<&TranscriptCursor>, limit: u64) -> TranscriptDelta {
        follow(&self.path, &json!("session-1"), previous, limit)
            .expect("follow")
            .expect("transcript exists")
    }
}

#[test]
fn a_transcript_that_does_not_exist_yet_is_still_waiting() {
    let dir = tempfile::tempdir().unwrap();

    let answer = follow(&dir.path().join("t.jsonl"), &json!("s"), None, ROOMY).unwrap();

    assert!(answer.is_none());
}

#[test]
fn the_first_read_is_a_fresh_tail_of_whole_records() {
    let transcript = Transcript::new(b"first\nsecond\npartial");

    let all = transcript.read(None, ROOMY);
    assert!(all.reset);
    assert_eq!(all.data, "first\nsecond\n");
    assert_eq!(
        all.cursor.offset, 13,
        "the cursor stops before the open record"
    );

    // 14 bytes back is exactly where `second` begins.
    assert_eq!(transcript.read(None, 14).data, "second\n");
    // 12 bytes back lands inside `second`: its tail is not a record, and the
    // open record at the end is not one yet.
    let cut = transcript.read(None, 12);
    assert_eq!(cut.data, "");
    assert_eq!(cut.cursor.offset, 13);
}

#[test]
fn an_empty_transcript_is_an_empty_fresh_tail() {
    let transcript = Transcript::new(b"");

    let first = transcript.read(None, ROOMY);

    assert!(first.reset);
    assert_eq!(first.data, "");
    assert_eq!(first.cursor.offset, 0);
}

#[test]
fn growth_is_answered_with_only_the_appended_records() {
    let transcript = Transcript::new(b"one\ntwo\n");
    let first = transcript.read(None, ROOMY);
    assert_eq!(first.data, "one\ntwo\n");

    transcript.append(b"three\n");
    let second = transcript.read(Some(&first.cursor), ROOMY);
    assert!(!second.reset);
    assert_eq!(second.data, "three\n");

    transcript.append(b"four\nfive\n");
    let third = transcript.read(Some(&second.cursor), ROOMY);
    assert!(!third.reset);
    assert_eq!(third.data, "four\nfive\n");
    assert_eq!(third.cursor.offset, 24);
}

#[test]
fn a_record_still_being_written_is_held_back_until_it_is_complete() {
    let transcript = Transcript::new(b"one\n");
    let first = transcript.read(None, ROOMY);

    transcript.append(b"{\"half\":");
    let waiting = transcript.read(Some(&first.cursor), ROOMY);
    assert!(!waiting.reset);
    assert_eq!(waiting.data, "");
    assert_eq!(waiting.cursor.offset, first.cursor.offset);

    transcript.append(b"true}\n");
    let complete = transcript.read(Some(&waiting.cursor), ROOMY);
    assert!(!complete.reset);
    assert_eq!(complete.data, "{\"half\":true}\n");
}

#[test]
fn an_unchanged_file_is_answered_with_the_same_cursor_and_nothing_else() {
    let transcript = Transcript::new(b"one\nopen");
    let first = transcript.read(None, ROOMY);

    let again = transcript.read(Some(&first.cursor), ROOMY);

    assert!(!again.reset);
    assert_eq!(again.data, "");
    assert_eq!(again.cursor, first.cursor);
}

#[test]
fn a_truncated_file_starts_over() {
    let transcript = Transcript::new(b"one\ntwo\n");
    let first = transcript.read(None, ROOMY);

    transcript.rewrite(b"x\n");
    let after = transcript.read(Some(&first.cursor), ROOMY);

    assert!(after.reset);
    assert_eq!(after.data, "x\n");

    transcript.rewrite(b"");
    let emptied = transcript.read(Some(&after.cursor), ROOMY);
    assert!(emptied.reset);
    assert_eq!(emptied.data, "");
}

#[test]
fn a_file_truncated_and_regrown_past_the_cursor_starts_over() {
    let transcript = Transcript::new(b"one\ntwo\n");
    let first = transcript.read(None, ROOMY);

    // Larger than before, same inode — but the cursor now points into the
    // middle of a record.
    transcript.rewrite(b"abcdefghijklmnop\nq\n");
    let after = transcript.read(Some(&first.cursor), ROOMY);

    assert!(after.reset);
    assert_eq!(after.data, "abcdefghijklmnop\nq\n");
}

#[test]
fn a_rewrite_in_place_of_the_same_size_starts_over() {
    let transcript = Transcript::new(b"one\ntwo\n");
    let first = transcript.read(None, ROOMY);

    transcript.rewrite(b"ONE\nTWO\n");
    // The clock may not have moved between the two writes; say so explicitly.
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    OpenOptions::new()
        .write(true)
        .open(&transcript.path)
        .unwrap()
        .set_modified(later)
        .unwrap();
    let after = transcript.read(Some(&first.cursor), ROOMY);

    assert!(after.reset);
    assert_eq!(after.data, "ONE\nTWO\n");
}

// Windows offers no stable file identity here (its creation time survives a
// same-name replacement), so there only the size and boundary checks apply.
#[cfg(unix)]
#[test]
fn a_replaced_file_starts_over_even_when_it_lines_up_with_the_cursor() {
    let transcript = Transcript::new(b"aaa\nbbb\n");
    let first = transcript.read(None, ROOMY);

    // A new file moved into place: longer, and with a newline exactly where
    // the old cursor sits, so only its identity gives it away.
    let staged = transcript.path.with_extension("staged");
    std::fs::write(&staged, b"ccc\nddd\neee\n").unwrap();
    std::fs::rename(&staged, &transcript.path).unwrap();
    let after = transcript.read(Some(&first.cursor), ROOMY);

    assert!(after.reset);
    assert_eq!(after.data, "ccc\nddd\neee\n");
}

#[test]
fn another_session_on_the_same_file_starts_over() {
    let transcript = Transcript::new(b"one\n");
    let first = transcript.read(None, ROOMY);

    let other = follow(
        &transcript.path,
        &json!("session-2"),
        Some(&first.cursor),
        ROOMY,
    )
    .unwrap()
    .unwrap();

    assert!(other.reset);
    assert_eq!(other.data, "one\n");
}

#[test]
fn more_unread_bytes_than_the_bound_start_over_with_a_bounded_tail() {
    let transcript = Transcript::new(b"a\n");
    let first = transcript.read(None, 16);

    transcript.append(&b"0123456\n".repeat(10));
    let after = transcript.read(Some(&first.cursor), 16);

    assert!(after.reset);
    assert_eq!(after.data, "0123456\n0123456\n");
    assert_eq!(after.cursor.offset, 82);
}

#[test]
fn a_record_larger_than_the_bound_is_skipped_and_following_resumes_after_it() {
    let transcript = Transcript::new(&[b'x'; 100]);
    let open = transcript.read(None, 16);
    assert_eq!(open.data, "");

    transcript.append(b"\n");
    let closed = transcript.read(Some(&open.cursor), 16);
    assert_eq!(closed.data, "", "no whole record fits in the window");

    transcript.append(b"ok\n");
    let next = transcript.read(Some(&closed.cursor), 16);
    assert!(!next.reset);
    assert_eq!(next.data, "ok\n");
}

#[test]
fn a_multi_byte_character_is_never_split_across_answers() {
    let transcript = Transcript::new("先\n".as_bytes());
    let first = transcript.read(None, ROOMY);
    assert_eq!(first.data, "先\n");

    // "café 👋" cut in the middle of `é`, then in the middle of the emoji.
    let record = "café 👋\n".as_bytes();
    transcript.append(&record[..4]);
    let mid_accent = transcript.read(Some(&first.cursor), ROOMY);
    assert_eq!(mid_accent.data, "");

    transcript.append(&record[4..8]);
    let mid_emoji = transcript.read(Some(&mid_accent.cursor), ROOMY);
    assert_eq!(mid_emoji.data, "");

    transcript.append(&record[8..]);
    let whole = transcript.read(Some(&mid_emoji.cursor), ROOMY);
    assert_eq!(whole.data, "café 👋\n");
}

#[test]
fn a_tail_window_that_opens_inside_a_character_starts_at_the_next_record() {
    // `日本語\n` is ten bytes; an eleven-byte window over thirteen opens two
    // bytes into `日`.
    let transcript = Transcript::new("日本語\nok\n".as_bytes());

    let tail = transcript.read(None, 11);

    assert_eq!(tail.data, "ok\n");
    assert!(!tail.data.contains('\u{FFFD}'));
}

#[test]
fn crlf_records_are_delivered_whole() {
    let transcript = Transcript::new(b"one\r\ntwo\r\n");
    let first = transcript.read(None, ROOMY);
    assert_eq!(first.data, "one\r\ntwo\r\n");

    transcript.append(b"three\r\nfou");
    let second = transcript.read(Some(&first.cursor), ROOMY);

    assert_eq!(second.data, "three\r\n");
}

#[test]
fn a_cursor_that_lies_gets_a_fresh_tail_never_a_split_record() {
    let transcript = Transcript::new(b"one\ntwo\n");
    let honest = transcript.read(None, ROOMY).cursor;
    transcript.append(b"three\n");

    let forged = [
        // Into the middle of a record.
        TranscriptCursor {
            offset: 2,
            size: 8,
            ..honest.clone()
        },
        // Past the end of the file.
        TranscriptCursor {
            offset: u64::MAX,
            size: u64::MAX,
            ..honest.clone()
        },
        // Past the size it claims to have seen.
        TranscriptCursor {
            offset: 8,
            size: 4,
            ..honest.clone()
        },
        // Another file's identity.
        TranscriptCursor {
            identity: "/etc/passwd:null:0:0".into(),
            ..honest.clone()
        },
    ];
    for cursor in forged {
        let answer = transcript.read(Some(&cursor), ROOMY);
        assert!(answer.reset, "{cursor:?}");
        assert_eq!(answer.data, "one\ntwo\nthree\n", "{cursor:?}");
    }
}

#[test]
fn the_wire_shape_is_what_the_frontend_echoes_back() {
    let transcript = Transcript::new(b"one\n");
    let first = transcript.read(None, ROOMY);

    let wire = serde_json::to_value(&first).unwrap();

    assert_eq!(wire["reset"], true);
    assert_eq!(wire["data"], "one\n");
    assert_eq!(wire["cursor"]["offset"], 4);
    assert_eq!(wire["cursor"]["size"], 4);
    assert!(wire["cursor"]["identity"].is_string());
    assert!(wire["cursor"]["modified"].is_string());
    let echoed: TranscriptCursor = serde_json::from_value(wire["cursor"].clone()).unwrap();
    assert_eq!(echoed, first.cursor);
}
