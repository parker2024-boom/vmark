// WI-RA7C.2 — text Rust did not write reaches a log line escaped. A path or a
// name interpolated with `{}` can carry a newline, and with it a forged log
// line in VMark's own format. This gate fails on the two shapes that put such
// text into a log macro unescaped:
//
//   1. `path.display()` as an argument — `Display` for a path escapes nothing;
//      `{:?}` on the path itself quotes and escapes it.
//   2. a `Display` placeholder wrapped in quotes or backticks (`'{}'`,
//      `'{name}'`, `` `{}` ``). The quotes say "this is a name", and a name is
//      exactly what must go through `{:?}` or `peer_text`, which add their own.
//
// A bare `{}` cannot be judged from syntax (it is right for a number or a
// constant), so text from a webview, a peer or a file that is logged that way
// is `peer_text` / `peer_message` at the call site — see `peer_text.rs`.

use crate::source_scan::{production_files, Production};

/// `(offset, raw text)` of every log macro call's argument list in `file`.
fn log_calls(file: &Production) -> Vec<(usize, &str)> {
    let opener = regex::Regex::new(r"\blog::(?:error|warn|info|debug|trace)!\s*\(").expect("regex");
    let code = file.code.as_bytes();
    opener
        .find_iter(&file.code)
        .map(|found| {
            // Literal contents are blanked in `code`, so every parenthesis
            // left is structure.
            let mut depth = 1usize;
            let mut end = found.end();
            while end < code.len() && depth > 0 {
                match code[end] {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                end += 1;
            }
            (found.start(), &file.raw[found.end()..end - 1])
        })
        .collect()
}

/// Why this log call's arguments are refused, if they are.
fn unescaped(arguments: &str) -> Option<&'static str> {
    let display = regex::Regex::new(r"\.\s*display\s*\(\s*\)").expect("regex");
    let quoted = regex::Regex::new(r#"(?:'|`|\\")\{[^{}?]*\}(?:'|`|\\")"#).expect("regex");
    if display.is_match(arguments) {
        Some("logs a path with `.display()` — use `{:?}` on the path")
    } else if quoted.is_match(arguments) {
        Some("logs a quoted `{}` — use `{:?}` or `peer_text`, which quote and escape")
    } else {
        None
    }
}

#[test]
fn the_gate_sees_both_unescaped_shapes() {
    for arguments in [
        r#""[fs] cannot allow '{}': {}", path.display(), e"#,
        r#""cannot read {}: {e}", path.display()"#,
        r#""Skipping '{}': {}", name, reason"#,
        r#""window '{label}' closed""#,
        r#""could not theme `{label}`: {e}""#,
        r#""peer sent \"{}\" before auth", kind"#,
    ] {
        assert!(unescaped(arguments).is_some(), "not flagged: {arguments}");
    }
}

#[test]
fn the_gate_accepts_escaped_and_plain_values() {
    for arguments in [
        r#""cannot read {:?}: {e}", path"#,
        r#""window {label:?} closed""#,
        r#""window {} closed", peer_text(&label)"#,
        r#""{} of {} files", done, total"#,
        r#""use nested form: `{}: {{ type: x }}`", peer_text(key)"#,
        r#""took {:.2}s", elapsed"#,
    ] {
        assert_eq!(unescaped(arguments), None, "flagged: {arguments}");
    }
}

#[test]
fn no_production_log_call_interpolates_a_path_or_a_quoted_name_unescaped() {
    let files = production_files();
    let mut calls = 0usize;
    let mut offenders = Vec::new();
    for file in &files {
        for (at, arguments) in log_calls(file) {
            calls += 1;
            if let Some(why) = unescaped(arguments) {
                offenders.push(format!("{} {why}", file.locate(at)));
            }
        }
    }
    // A scan that found no log calls would pass whatever the tree held.
    assert!(calls > 300, "only {calls} log calls were scanned");
    assert!(
        offenders.is_empty(),
        "{} log call(s) can be forged by the text they interpolate (see peer_text.rs):\n{}",
        offenders.len(),
        offenders.join("\n")
    );
}
