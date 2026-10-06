// WI-RA7C.1 — the reader every source-scan gate in this crate shares: the
// production `.rs` files under `src/`, with comments, the contents of string
// and char literals, and test-only items blanked out, so a gate's pattern can
// only ever match code that ships.
//
// Blanking (spaces, newlines kept) rather than deleting keeps byte offsets: a
// finding maps back to its line, and a gate that needs a literal's text (a log
// format string) reads it from `raw` at the offsets `code` gave it. Quote
// characters survive the blanking, so a literal's bounds stay visible.
//
// Which files are test-only is read from the `#[cfg(test)] mod` declarations
// themselves, not guessed from names, so a test module with an ordinary name
// (`genies/tests.rs`, `workflow/examples.rs`) is never scanned as shipping
// code and a production file is never skipped because of what it is called.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// One production file, ready to scan.
pub(crate) struct Production {
    /// Path relative to `src/`, with `/` separators.
    pub(crate) path: String,
    /// The file exactly as written.
    pub(crate) raw: String,
    /// `raw` with comments, literal contents and test-only items blanked.
    pub(crate) code: String,
}

impl Production {
    /// 1-based line number of a byte offset.
    pub(crate) fn line_of(&self, offset: usize) -> usize {
        self.code[..offset].matches('\n').count() + 1
    }

    /// `path:line`, for an offender list.
    pub(crate) fn locate(&self, offset: usize) -> String {
        format!("{}:{}", self.path, self.line_of(offset))
    }
}

/// The crate's `src/` directory.
pub(crate) fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Every production source file under `src/`, in a stable order.
pub(crate) fn production_files() -> Vec<Production> {
    let root = src_root();
    let mut all = Vec::new();
    collect_rs(&root, &mut all);
    all.sort();
    let test_only = test_only_files(&all);
    let found: Vec<Production> = all
        .iter()
        .filter(|path| !test_only.iter().any(|t| path.starts_with(t)))
        .filter(|path| !path.to_string_lossy().ends_with(".test.rs"))
        .map(|path| {
            let raw = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let rel = path
                .strip_prefix(&root)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/");
            Production {
                path: rel,
                code: blank_test_items(&blank_comments_and_literals(&raw)),
                raw,
            }
        })
        .collect();
    // A scan that read nothing would pass every gate built on it.
    assert!(
        found.len() > 100,
        "only {} production files found",
        found.len()
    );
    found
}

/// Every `.rs` file under `src/`, test files included, as `(path, code)` with
/// comments and literal contents blanked. For a rule that holds in tests too.
pub(crate) fn all_files() -> Vec<(String, String)> {
    let root = src_root();
    let mut all = Vec::new();
    collect_rs(&root, &mut all);
    all.sort();
    all.iter()
        .map(|path| {
            let raw = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let rel = path
                .strip_prefix(&root)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/");
            (rel, blank_comments_and_literals(&raw))
        })
        .collect()
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("list {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Files and directories that only `#[cfg(test)]` (or `#[cfg(all(test, …))]`)
/// module declarations bring in.
fn test_only_files(all: &[PathBuf]) -> BTreeSet<PathBuf> {
    let declaration = regex::Regex::new(
        r#"#\[cfg\((?:test|all\(\s*test\b[^\]]*)\)\]\s*((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;"#,
    )
    .expect("declaration regex");
    let path_attr = regex::Regex::new(r#"#\[path\s*=\s*"([^"]+)"\]"#).expect("path regex");
    let mut test_only = BTreeSet::new();
    for file in all {
        let raw = std::fs::read_to_string(file).expect("read source");
        let code = blank_comments_and_literals(&raw);
        let dir = file.parent().expect("file has a directory");
        let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        for found in declaration.captures_iter(&raw) {
            let start = found.get(0).expect("whole match").start();
            if !code[start..].starts_with('#') {
                continue; // inside a comment or a literal
            }
            let name = &found[2];
            let target = match path_attr.captures(&found[1]) {
                Some(path) => dir.join(&path[1]),
                None if matches!(stem, "mod" | "lib" | "main") => dir.join(name),
                None => dir.join(stem).join(name),
            };
            if target.extension().is_some() {
                test_only.insert(target);
            } else {
                // `name.rs`, or a directory module `name/` (all of it).
                test_only.insert(target.with_extension("rs"));
                test_only.insert(target);
            }
        }
    }
    test_only
}

/// Replace comments and the CONTENTS of string, byte-string, raw-string and
/// char literals with spaces. Quotes and newlines survive.
pub(crate) fn blank_comments_and_literals(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in &mut out[from..to] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    while i < bytes.len() {
        let rest = &bytes[i..];
        if rest.starts_with(b"//") {
            let end = rest
                .iter()
                .position(|&b| b == b'\n')
                .map_or(bytes.len(), |n| i + n);
            blank(&mut out, i, end);
            i = end;
        } else if rest.starts_with(b"/*") {
            let mut depth = 0usize;
            let mut j = i;
            while j < bytes.len() {
                if bytes[j..].starts_with(b"/*") {
                    depth += 1;
                    j += 2;
                } else if bytes[j..].starts_with(b"*/") {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            blank(&mut out, i, j);
            i = j;
        } else if (rest[0] == b'r' || rest.starts_with(b"br"))
            && (i == 0 || !ident(bytes[i - 1]))
            && raw_string_open(rest).is_some()
        {
            let (prefix, hashes) = raw_string_open(rest).expect("checked above");
            let body = i + prefix;
            let mut close = vec![b'"'];
            close.extend(std::iter::repeat_n(b'#', hashes));
            let end = bytes[body..]
                .windows(close.len())
                .position(|w| w == close.as_slice())
                .map_or(bytes.len(), |n| body + n);
            blank(&mut out, body, end);
            i = (end + close.len()).min(bytes.len());
        } else if rest[0] == b'"' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'"' {
                j += if bytes[j] == b'\\' { 2 } else { 1 };
            }
            let end = j.min(bytes.len());
            blank(&mut out, i + 1, end);
            i = end + 1;
        } else if rest[0] == b'\'' {
            match char_literal_len(rest) {
                Some(len) => {
                    blank(&mut out, i + 1, i + len - 1);
                    i += len;
                }
                None => i += 1, // a lifetime or a label
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("only ASCII bytes were replaced")
}

/// `r"`, `r#"`, `br##"` …: the prefix length up to and including the quote,
/// and the number of hashes.
fn raw_string_open(rest: &[u8]) -> Option<(usize, usize)> {
    let after_r = if rest.starts_with(b"br") { 2 } else { 1 };
    let hashes = rest[after_r..].iter().take_while(|&&b| b == b'#').count();
    (rest.get(after_r + hashes) == Some(&b'"')).then_some((after_r + hashes + 1, hashes))
}

/// The byte length of a char literal starting at `rest[0] == '\''`, or `None`
/// when the quote starts a lifetime or a label.
fn char_literal_len(rest: &[u8]) -> Option<usize> {
    if rest.get(1) == Some(&b'\\') {
        // The escaped character itself may be a quote (`'\''`), so the search
        // for the closing one starts after it.
        let close = rest.get(3..)?.iter().position(|&b| b == b'\'')?;
        return Some(close + 4);
    }
    // A char literal is at most six bytes; a bounded window keeps this O(1)
    // per quote. The cut may split a character, so keep its valid prefix.
    let window = &rest[..rest.len().min(8)];
    let text = match std::str::from_utf8(window) {
        Ok(text) => text,
        Err(e) => std::str::from_utf8(&window[..e.valid_up_to()]).ok()?,
    };
    let mut chars = text.char_indices().skip(1);
    let (_, ch) = chars.next()?;
    let (at, next) = chars.next()?;
    (next == '\'' && ch != '\'').then_some(at + 1)
}

/// Blank every item a `#[cfg(test)]` or `#[cfg(all(test, …))]` attribute
/// gates: up to its `;`, or through the brace that closes its body.
pub(crate) fn blank_test_items(code: &str) -> String {
    let attribute =
        regex::Regex::new(r"#\[cfg\((?:test|all\(\s*test\b[^\]]*)\)\]").expect("cfg(test) regex");
    let bytes = code.as_bytes();
    let mut out = bytes.to_vec();
    let mut resume = 0;
    for found in attribute.find_iter(code) {
        if found.start() < resume {
            continue; // inside an item already blanked
        }
        let end = item_end(bytes, found.end());
        for byte in &mut out[found.start()..end] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
        resume = end;
    }
    String::from_utf8(out).expect("only ASCII bytes were replaced")
}

/// The end of the item that starts at or after `from`: past its first `;` at
/// depth zero, or past the `}` that closes its first `{`.
fn item_end(bytes: &[u8], from: usize) -> usize {
    let mut depth = 0i32;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b';' if depth == 0 => return i + 1,
            b'{' if depth == 0 => {
                let mut braces = 0i32;
                for (j, &byte) in bytes.iter().enumerate().skip(i) {
                    match byte {
                        b'{' => braces += 1,
                        b'}' => {
                            braces -= 1;
                            if braces == 0 {
                                return j + 1;
                            }
                        }
                        _ => {}
                    }
                }
                return bytes.len();
            }
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

#[test]
fn comments_and_literal_contents_are_blanked_but_quotes_and_lines_survive() {
    let source = "let a = \"x.lock()\"; // y.lock()\n/* z /* nested */ .lock() */ let b = r#\"q\"#;\nlet c = '\"'; let d: &'static str = \"\\\"\";";
    let code = blank_comments_and_literals(source);
    assert_eq!(code.len(), source.len());
    assert!(!code.contains("lock"), "{code}");
    assert_eq!(code.matches('\n').count(), 2);
    assert!(code.contains("let a = \"        \";"), "{code}");
    assert!(
        code.contains("&'static str"),
        "a lifetime is not a literal: {code}"
    );
    assert!(code.contains("let b = r#\" \"#;"), "{code}");
}

#[test]
fn test_only_items_are_blanked_and_production_items_are_kept() {
    let code = "fn kept() {}\n#[cfg(test)]\nfn gone() { inner(); }\n#[cfg(all(test, unix))]\nmod also_gone;\n#[cfg(any(test, windows))]\nfn kept_too() {}\n";
    let scanned = blank_test_items(code);
    assert!(scanned.contains("fn kept()"));
    assert!(
        scanned.contains("fn kept_too()"),
        "any(test, …) ships on windows"
    );
    assert!(!scanned.contains("gone"), "{scanned}");
    assert!(!scanned.contains("inner"), "{scanned}");
}

#[test]
fn the_scan_skips_test_modules_whatever_they_are_called() {
    let files: Vec<String> = production_files().into_iter().map(|f| f.path).collect();
    for test_only in [
        "genies/tests.rs",
        "workflow/examples.rs",
        "source_scan.test.rs",
    ] {
        assert!(
            !files.iter().any(|f| f == test_only),
            "{test_only} was scanned"
        );
    }
    for shipped in [
        "lib.rs",
        "genies/mod.rs",
        "workflow/mod.rs",
        "pty/reader.rs",
    ] {
        assert!(
            files.iter().any(|f| f == shipped),
            "{shipped} was not scanned"
        );
    }
}
