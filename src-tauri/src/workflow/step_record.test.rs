// WI-RA5.3 — the record phase, split out of the runner: the copy of a step's
// output sent to the frontend is cut on a character boundary.
//
//! Unit tests for `step_record.rs`. What a recorded step does to the run —
//! outputs, events, the first failure — is exercised through whole runs in
//! `runner_flow.test.rs`.

use super::*;

#[test]
fn test_truncate_utf8_safe_ascii() {
    let s = "hello world";
    assert_eq!(truncate_utf8_safe(s, 100), s);
}

#[test]
fn test_truncate_utf8_safe_cjk() {
    let s = "你好世界测试数据";
    // Each CJK char is 3 bytes. 8 chars = 24 bytes.
    let result = truncate_utf8_safe(s, 10);
    // Should truncate at char boundary, not panic
    assert!(result.contains("..."));
    assert!(!result.is_empty());
}

#[test]
fn the_kept_prefix_never_exceeds_the_limit() {
    // Three-byte characters, and every limit that falls inside one of them.
    let s = "你好世界测试数据";
    for max in 0..s.len() {
        let out = truncate_utf8_safe(s, max);
        let kept = out
            .split_once("...")
            .map(|(kept, _)| kept)
            .expect("a truncated output is marked");
        assert!(kept.len() <= max, "limit {max}: kept {} bytes", kept.len());
        assert!(s.starts_with(kept), "limit {max}: {kept:?} is not a prefix");
        // …and it keeps every whole character that fits.
        assert!(kept.len() + 3 > max, "limit {max}: kept only {kept:?}");
        assert!(out.ends_with("[Output truncated for display: 24 bytes total]"));
    }
    // At or above the length nothing is cut.
    assert_eq!(truncate_utf8_safe(s, s.len()), s);
    assert_eq!(truncate_utf8_safe("", 0), "");
}
