// WI-RA11.3 — the content search's results on one fixture tree, pinned in
// full: which files are scanned, which are excluded by design, which void
// completeness, and the exact line numbers and UTF-16 ranges that come back.
// The walk and the per-file scan were restructured underneath these values.

use super::*;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

/// One search over the fixture: the options a caller can vary.
struct Case {
    name: &'static str,
    /// Searched directory, relative to the fixture root ("" = the root).
    subdir: &'static str,
    query: &'static str,
    case_sensitive: bool,
    whole_word: bool,
    use_regex: bool,
    markdown_only: bool,
    extensions: &'static [&'static str],
    exclude_folders: &'static [&'static str],
}

impl Case {
    const fn plain(name: &'static str, query: &'static str) -> Self {
        Case {
            name,
            subdir: "",
            query,
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            markdown_only: false,
            extensions: &[],
            exclude_folders: &[],
        }
    }

    fn run(&self, root: &Path, deadline: Instant) -> Result<SearchOutcome, String> {
        search_sync_with_deadline(
            root.join(self.subdir).to_str().unwrap(),
            self.query,
            self.case_sensitive,
            self.whole_word,
            self.use_regex,
            self.markdown_only,
            self.extensions.iter().map(|e| e.to_string()).collect(),
            self.exclude_folders.iter().map(|e| e.to_string()).collect(),
            deadline,
        )
    }
}

/// Every option the search takes, exercised at least once.
const CASES: &[Case] = &[
    Case::plain("default", "World"),
    Case {
        case_sensitive: true,
        ..Case::plain("case sensitive", "World")
    },
    Case {
        whole_word: true,
        ..Case::plain("whole word, no such word", "wor")
    },
    Case {
        whole_word: true,
        ..Case::plain("whole word", "world")
    },
    Case {
        case_sensitive: true,
        use_regex: true,
        ..Case::plain("regex anchored at line end", "W.rld$")
    },
    Case {
        markdown_only: true,
        extensions: &[".MD"],
        ..Case::plain("markdown only", "World")
    },
    Case {
        exclude_folders: &["excluded", "notes"],
        ..Case::plain("excluded folders", "World")
    },
    Case {
        subdir: "notes",
        ..Case::plain("clean subtree", "World")
    },
    Case {
        subdir: "notes",
        ..Case::plain("clean subtree, no hits", "no-such-probe")
    },
    Case::plain("non-ASCII query", "世界"),
];

/// A workspace with one of everything the walker has a rule for.
fn fixture() -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    let write = |relative: &str, contents: &[u8]| {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    };

    write(
        "a.md",
        "Hello World\nhello again\n世界 hello 🌍 World\n".as_bytes(),
    );
    write("notes/b.md", b"alpha\nWorld of notes\nworld lower\n");
    write("notes/deep/c.txt", b"World in txt\n");
    write("crlf.md", b"World\r\nline two World\r\n");
    write("empty.md", b"");
    write(
        "long.md",
        format!("{} World {}\n", "x".repeat(300), "y".repeat(300)).as_bytes(),
    );
    write("excluded/e.md", b"World excluded\n");

    // Excluded BY DESIGN — none of these may void completeness.
    write("notes/.hidden.md", b"World hidden\n");
    write(".git/config", b"World in the repository metadata\n");
    write("node_modules/x.md", b"World in deps\n");
    write("bin.dat", b"World\0binary");

    // Eligible but never scanned — each of these voids completeness.
    write("big.md", "filler World line\n".repeat(70_000).as_bytes()); // > 1 MB
    write(
        "invalid.md",
        &[0xFF, 0xFE, b'W', b'o', b'r', b'l', b'd', b'\n'],
    ); // not UTF-8, no NUL

    #[cfg(unix)]
    {
        // Links are never followed: each would report `a.md` / `notes` twice.
        std::os::unix::fs::symlink(root.join("a.md"), root.join("link.md")).unwrap();
        std::os::unix::fs::symlink(root.join("notes"), root.join("linkdir")).unwrap();
    }
    dir
}

type LineSummary = (u32, Vec<(u32, u32)>);

/// `relative path → (line number, UTF-16 ranges)`, ordered by path. Files in
/// one directory come back in the OS's enumeration order, which is not part
/// of the contract.
fn summary(outcome: &SearchOutcome) -> Vec<(String, Vec<LineSummary>)> {
    let mut files: Vec<(String, Vec<LineSummary>)> = outcome
        .results
        .iter()
        .map(|file| {
            let lines = file
                .matches
                .iter()
                .map(|m| {
                    let ranges = m.match_ranges.iter().map(|r| (r.start, r.end)).collect();
                    (m.line_number, ranges)
                })
                .collect();
            (file.relative_path.clone(), lines)
        })
        .collect();
    files.sort();
    files
}

fn run(name: &str, root: &Path) -> SearchOutcome {
    let case = CASES
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("no fixture case named {name:?}"));
    case.run(root, Instant::now() + Duration::from_secs(60))
        .unwrap()
}

fn file(path: &str, lines: &[(u32, &[(u32, u32)])]) -> (String, Vec<LineSummary>) {
    let lines = lines.iter().map(|(n, r)| (*n, r.to_vec())).collect();
    (path.to_string(), lines)
}

#[test]
fn the_default_search_finds_every_scanned_line_and_reports_the_skips() {
    let dir = fixture();
    let outcome = run("default", dir.path());

    assert_eq!(
        summary(&outcome),
        vec![
            // "世界 hello 🌍 World": the emoji is two UTF-16 units.
            file("a.md", &[(1, &[(6, 11)]), (3, &[(12, 17)])]),
            // CRLF endings are not part of the line.
            file("crlf.md", &[(1, &[(0, 5)]), (2, &[(9, 14)])]),
            file("excluded/e.md", &[(1, &[(0, 5)])]),
            // A 607-char line is windowed around its first match.
            file("long.md", &[(1, &[(31, 36)])]),
            file("notes/b.md", &[(2, &[(0, 5)]), (3, &[(0, 5)])]),
            file("notes/deep/c.txt", &[(1, &[(0, 5)])]),
        ]
    );
    assert!(
        !outcome.complete,
        "the oversized and the non-UTF-8 file were eligible and went unscanned"
    );
}

#[test]
fn a_result_carries_its_absolute_and_relative_path_and_the_windowed_line() {
    let dir = fixture();
    let outcome = run("default", dir.path());

    let long = outcome
        .results
        .iter()
        .find(|r| r.relative_path == "long.md")
        .expect("long.md matches");
    assert_eq!(long.path, dir.path().join("long.md").to_string_lossy());
    assert_eq!(
        long.matches[0].line_content,
        format!("…{} World {}…", "x".repeat(29), "y".repeat(164))
    );

    let nested = outcome
        .results
        .iter()
        .find(|r| r.relative_path == "notes/deep/c.txt")
        .expect("nested file matches");
    assert_eq!(
        nested.path,
        dir.path()
            .join("notes")
            .join("deep")
            .join("c.txt")
            .to_string_lossy()
    );
    assert_eq!(nested.matches[0].line_content, "World in txt");
}

#[test]
fn case_sensitivity_drops_only_the_lower_case_line() {
    let dir = fixture();
    let outcome = run("case sensitive", dir.path());
    let files = summary(&outcome);
    let notes = files.iter().find(|(path, _)| path == "notes/b.md").unwrap();
    assert_eq!(notes.1, vec![(2, vec![(0, 5)])]);
    assert_eq!(files.len(), 6);
}

#[test]
fn whole_word_matches_words_and_nothing_inside_them() {
    let dir = fixture();
    assert!(summary(&run("whole word, no such word", dir.path())).is_empty());
    assert_eq!(
        summary(&run("whole word", dir.path())),
        summary(&run("default", dir.path()))
    );
}

#[test]
fn a_regex_is_matched_per_line() {
    let dir = fixture();
    assert_eq!(
        summary(&run("regex anchored at line end", dir.path())),
        vec![
            file("a.md", &[(1, &[(6, 11)]), (3, &[(12, 17)])]),
            file("crlf.md", &[(1, &[(0, 5)]), (2, &[(9, 14)])]),
        ]
    );
}

#[test]
fn markdown_only_drops_other_extensions_and_still_reports_the_skips() {
    let dir = fixture();
    let outcome = run("markdown only", dir.path());
    let paths: Vec<String> = summary(&outcome)
        .into_iter()
        .map(|(path, _)| path)
        .collect();
    assert_eq!(
        paths,
        vec!["a.md", "crlf.md", "excluded/e.md", "long.md", "notes/b.md"]
    );
    assert!(!outcome.complete);
}

#[test]
fn excluded_folders_are_not_entered() {
    let dir = fixture();
    let outcome = run("excluded folders", dir.path());
    let paths: Vec<String> = summary(&outcome)
        .into_iter()
        .map(|(path, _)| path)
        .collect();
    assert_eq!(paths, vec!["a.md", "crlf.md", "long.md"]);
}

#[test]
fn a_subtree_with_only_by_design_exclusions_is_a_complete_scan() {
    let dir = fixture();
    let outcome = run("clean subtree", dir.path());
    assert_eq!(
        summary(&outcome),
        vec![
            file("b.md", &[(2, &[(0, 5)]), (3, &[(0, 5)])]),
            file("deep/c.txt", &[(1, &[(0, 5)])]),
        ]
    );
    assert!(outcome.complete, "a hidden file does not void completeness");

    let none = run("clean subtree, no hits", dir.path());
    assert!(none.results.is_empty());
    assert!(none.complete);
}

#[test]
fn a_non_ascii_query_reports_utf16_ranges() {
    let dir = fixture();
    assert_eq!(
        summary(&run("non-ASCII query", dir.path())),
        vec![file("a.md", &[(3, &[(0, 2)])])]
    );
}

#[test]
fn an_elapsed_deadline_scans_nothing_and_says_so() {
    let dir = fixture();
    for case in CASES {
        let outcome = case
            .run(dir.path(), Instant::now() - Duration::from_secs(1))
            .unwrap();
        assert!(
            outcome.results.is_empty(),
            "{}: nothing may be read",
            case.name
        );
        assert!(
            !outcome.complete,
            "{}: a spent budget is incomplete",
            case.name
        );
    }
}
