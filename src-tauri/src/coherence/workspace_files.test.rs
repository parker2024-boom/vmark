// WI-RA14B.3 — `.vmark/` bootstrap on disk: the idempotent rule append that
// must never destroy a user's file, the completion probes, the workspace
// flock, and the per-installation writer id.

use super::*;
use std::fs;
use std::path::Path;

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read_dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn ensure_line_creates_an_absent_file_with_the_line() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join(".gitignore");

    ensure_line(&path, "index.db*").expect("create");

    assert_eq!(fs::read_to_string(&path).unwrap(), "index.db*\n");
    assert_eq!(names(tmp.path()), vec![".gitignore"], "no temp file left");
}

#[test]
fn ensure_line_appends_and_keeps_every_existing_rule() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join(".gitignore");
    // No trailing newline: the new rule must not be glued onto the last one.
    fs::write(&path, "user-rule\n# 注释").expect("write");

    ensure_line(&path, "group.lock").expect("append");

    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "user-rule\n# 注释\ngroup.lock\n"
    );
}

#[test]
fn ensure_line_is_idempotent_and_matches_a_rule_with_surrounding_space_or_crlf() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join(".gitignore");
    let original = "a\r\n  group.lock  \r\nb\r\n";
    fs::write(&path, original).expect("write");

    ensure_line(&path, "group.lock").expect("present");
    ensure_line(&path, "group.lock").expect("still present");

    assert_eq!(fs::read_to_string(&path).unwrap(), original, "untouched");
    assert_eq!(names(tmp.path()), vec![".gitignore"]);
}

#[test]
fn ensure_line_refuses_to_overwrite_a_file_it_cannot_read() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join(".gitignore");
    let bytes = b"user-rule\n\xff\xfe not utf-8\n";
    fs::write(&path, bytes).expect("write");

    let err = ensure_line(&path, "group.lock").expect_err("refused");

    assert!(err.contains("refusing to overwrite"), "{err}");
    assert_eq!(fs::read(&path).unwrap(), bytes, "the user's file survives");
    assert_eq!(names(tmp.path()), vec![".gitignore"]);
}

#[test]
fn ensure_line_into_a_missing_folder_fails_and_leaves_nothing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("missing").join(".gitignore");

    let err = ensure_line(&path, "x").expect_err("no folder");

    assert!(err.contains("staging"), "{err}");
    assert!(names(tmp.path()).is_empty());
}

#[test]
fn ensure_line_refuses_a_folder_where_the_file_should_be() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join(".gitignore");
    fs::create_dir(&path).expect("a folder where the file should be");
    fs::write(path.join("keep"), "x").expect("write");

    // Reading a folder is an error that is not NotFound: refused up front.
    let err = ensure_line(&path, "x").expect_err("refused");

    assert!(err.contains("unreadable"), "{err}");
    assert_eq!(names(tmp.path()), vec![".gitignore"]);
    assert!(path.join("keep").is_file());
}

#[test]
fn lock_ignore_rules_are_written_only_when_the_file_is_absent() {
    let tmp = tempfile::tempdir().expect("tempdir");

    ensure_lock_ignore_rules(tmp.path()).expect("absent");
    assert_eq!(
        fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
        "index.db*\ngroup.lock\n"
    );
    assert!(ignore_rules_complete(tmp.path()));

    // A present file is left to `ensure_initialized`, even without the rules.
    let other = tempfile::tempdir().expect("tempdir");
    fs::write(other.path().join(".gitignore"), "mine\n").expect("write");
    ensure_lock_ignore_rules(other.path()).expect("present");
    assert_eq!(
        fs::read_to_string(other.path().join(".gitignore")).unwrap(),
        "mine\n"
    );
}

#[test]
fn ignore_rules_complete_needs_both_rules() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ignore = tmp.path().join(".gitignore");

    assert!(!ignore_rules_complete(tmp.path()), "absent");
    fs::write(&ignore, "index.db*\n").expect("write");
    assert!(!ignore_rules_complete(tmp.path()), "group.lock missing");
    fs::write(&ignore, "group.lock\n index.db* \n").expect("write");
    assert!(ignore_rules_complete(tmp.path()));
}

#[test]
fn fully_initialized_requires_the_marker_rule_and_both_folders() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let vmark = tmp.path();

    assert!(!is_fully_initialized(vmark), "empty");
    fs::write(
        vmark.join(".gitattributes"),
        format!("{MERGE_UNION_RULE}\n"),
    )
    .unwrap();
    assert!(
        !is_fully_initialized(vmark),
        "marker alone is not completion"
    );
    fs::create_dir(vmark.join("ledger")).unwrap();
    assert!(!is_fully_initialized(vmark), "snapshots missing");
    fs::create_dir(vmark.join("snapshots")).unwrap();
    assert!(is_fully_initialized(vmark));

    // A file named `snapshots` is not the folder.
    fs::remove_dir(vmark.join("snapshots")).unwrap();
    fs::write(vmark.join("snapshots"), "").unwrap();
    assert!(!is_fully_initialized(vmark));
    // The marker file without the rule is not the marker.
    fs::remove_file(vmark.join("snapshots")).unwrap();
    fs::create_dir(vmark.join("snapshots")).unwrap();
    fs::write(vmark.join(".gitattributes"), "*.md text\n").unwrap();
    assert!(!is_fully_initialized(vmark));
}

#[test]
fn flock_needs_an_existing_vmark_and_creates_only_the_lock_file() {
    let tmp = tempfile::tempdir().expect("tempdir");

    let err = flock_exclusive(&tmp.path().join("missing")).expect_err("no .vmark");
    assert!(err.starts_with("group lock open failed"), "{err}");
    assert!(
        names(tmp.path()).is_empty(),
        "`open` must not create .vmark"
    );

    let _held = flock_exclusive(tmp.path()).expect("lock");
    assert_eq!(names(tmp.path()), vec!["group.lock"]);
}

#[cfg(unix)]
#[test]
fn flock_is_exclusive_while_held_and_released_on_drop() {
    use std::os::unix::io::AsRawFd;
    let tmp = tempfile::tempdir().expect("tempdir");
    // flock locks belong to an open file description, so a second open of the
    // same file in this process contends exactly as another process would.
    let try_lock = || {
        let other = fs::File::open(tmp.path().join("group.lock")).expect("open");
        // SAFETY: `other` owns a valid fd for the duration of the call.
        let rc = unsafe { libc::flock(other.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        rc == 0
    };

    let held = flock_exclusive(tmp.path()).expect("lock");
    assert!(!try_lock(), "a second locker is refused while held");
    drop(held);
    assert!(try_lock(), "released when the file closes");
}

#[test]
fn writer_id_is_created_once_and_then_reused() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("app-data");

    let first = load_or_create_writer_id(&dir).expect("create");
    let second = load_or_create_writer_id(&dir).expect("reuse");

    assert_eq!(first.0, second.0);
    assert_eq!(
        fs::read_to_string(dir.join("coherence-writer-id")).unwrap(),
        first.0.to_string()
    );
    assert_eq!(
        names(&dir),
        vec!["coherence-writer-id"],
        "no temp link left"
    );
}

#[test]
fn writer_id_tolerates_surrounding_whitespace() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let id = uuid::Uuid::now_v7();
    fs::write(tmp.path().join("coherence-writer-id"), format!("  {id}\n")).unwrap();

    assert_eq!(load_or_create_writer_id(tmp.path()).unwrap().0, id);
}

#[test]
fn a_corrupt_writer_id_is_replaced_by_the_id_returned() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("coherence-writer-id");
    fs::write(&path, "not-a-uuid").unwrap();

    let id = load_or_create_writer_id(tmp.path()).expect("replaced");

    assert_eq!(fs::read_to_string(&path).unwrap(), id.0.to_string());
    assert_eq!(load_or_create_writer_id(tmp.path()).unwrap().0, id.0);
    // The repair lock is the one other file it leaves; no temp file.
    assert_eq!(
        names(tmp.path()),
        vec!["coherence-writer-id", "coherence-writer-id.lock"]
    );
}

/// Eight threads call `load_or_create_writer_id` at once; returns what each
/// got and what is on disk afterwards.
fn race_for_writer_id(dir: &Path) -> (Vec<uuid::Uuid>, String) {
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let ids = (0..8)
        .map(|_| {
            let (dir, barrier) = (dir.to_path_buf(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                load_or_create_writer_id(&dir).expect("id").0
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|h| h.join().expect("thread"))
        .collect();
    let on_disk = fs::read_to_string(dir.join("coherence-writer-id")).unwrap();
    (ids, on_disk)
}

#[test]
fn concurrent_first_runs_agree_on_one_writer_id() {
    let tmp = tempfile::tempdir().expect("tempdir");

    let (ids, on_disk) = race_for_writer_id(tmp.path());

    assert!(
        ids.iter().all(|id| id.to_string() == on_disk),
        "{ids:?} vs {on_disk}"
    );
    assert_eq!(names(tmp.path()), vec!["coherence-writer-id"]);
}

#[test]
fn concurrent_repairs_of_a_corrupt_writer_id_agree_on_one_id() {
    // Every process that starts against a corrupt id file repairs it. The
    // repairs must converge: a caller that comes away with an id other than
    // the one left on disk stamps its writes with an identity no later run
    // will ever load again.
    for _ in 0..20 {
        let tmp = tempfile::tempdir().expect("tempdir");
        fs::write(tmp.path().join("coherence-writer-id"), "corrupt").unwrap();

        let (ids, on_disk) = race_for_writer_id(tmp.path());

        assert!(
            ids.iter().all(|id| id.to_string() == on_disk),
            "{ids:?} vs {on_disk}"
        );
        assert_eq!(
            names(tmp.path()),
            vec!["coherence-writer-id", "coherence-writer-id.lock"]
        );
    }
}
