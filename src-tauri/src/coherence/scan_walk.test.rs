// WI-RA14B.3 — the scan walk's refusals are loud and never become deletions:
// a folder or file the walk cannot read, and a file past the size cap, each
// produce a diagnostic, and a document the walk could not see is never marked
// absent. Deletion is inferred from absence, so a walk that skipped something
// silently would delete it from the record.

use super::super::capture::{capture, CaptureRequest};
use super::super::scan::scan_workspace;
use super::super::scan::MAX_SCAN_FILE_BYTES;
use super::super::state::WorkspaceKernel;
use super::super::types::{Agent, AgentType, Confidence, Intent, WriterId};
use std::path::Path;

fn workspace() -> (tempfile::TempDir, WorkspaceKernel) {
    let dir = tempfile::tempdir().unwrap();
    let kernel = WorkspaceKernel::open(dir.path(), WriterId(uuid::Uuid::from_u128(1))).unwrap();
    (dir, kernel)
}

/// Write `rel` and record it as a captured document, as a save does.
fn captured(kernel: &mut WorkspaceKernel, root: &Path, rel: &str) {
    let body = format!("{rel}\n");
    let abs = root.join(rel);
    std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
    std::fs::write(&abs, &body).unwrap();
    let receipt = capture(
        kernel,
        CaptureRequest {
            path: rel.into(),
            content: body.clone(),
            inputs: vec![],
            agent: Agent {
                kind: AgentType::Human,
                id: None,
            },
            intent: Intent {
                kind: "editor-save".into(),
                summary: "save".into(),
                prompt_hash: None,
            },
            confidence: Confidence::Exact,
            rewrite_identity: true,
            idem: None,
        },
    )
    .unwrap();
    std::fs::write(&abs, receipt.content_with_identity.unwrap_or(body)).unwrap();
}

#[test]
fn a_file_past_the_size_cap_is_diagnosed_and_never_marked_absent() {
    let (dir, mut kernel) = workspace();
    captured(&mut kernel, dir.path(), "big.md");
    assert_eq!(scan_workspace(&mut kernel).unwrap().diagnostics, 0);
    // Sparse: the length is past the cap without writing the bytes.
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join("big.md"))
        .unwrap();
    file.set_len(MAX_SCAN_FILE_BYTES + 1).unwrap();

    let report = scan_workspace(&mut kernel).unwrap();

    assert_eq!(report.diagnostics, 1, "file-too-large");
    assert_eq!(report.absent_marked, 0, "too large to read is not deleted");
    assert_eq!(report.external_edits, 0);
}

#[test]
fn a_file_exactly_at_the_size_cap_is_still_scanned() {
    let (dir, mut kernel) = workspace();
    captured(&mut kernel, dir.path(), "seed.md");
    let at_cap = dir.path().join("at-cap.md");
    std::fs::write(&at_cap, "").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&at_cap)
        .unwrap()
        .set_len(MAX_SCAN_FILE_BYTES)
        .unwrap();

    let report = scan_workspace(&mut kernel).unwrap();

    // Read, not refused: NUL bytes are valid UTF-8, so no diagnostic at all.
    assert_eq!(report.diagnostics, 0);
    assert!(report.complete);
}

#[cfg(unix)]
mod unreadable {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Set `path`'s mode for the guard's lifetime, restoring 0o755 on drop so
    /// the temp dir can always be removed.
    struct Mode<'a>(&'a Path);
    impl<'a> Mode<'a> {
        fn set(path: &'a Path, mode: u32) -> Self {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
            Self(path)
        }
    }
    impl Drop for Mode<'_> {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    /// Root ignores permission bits; the property is only observable as an
    /// unprivileged user, which is how the app runs.
    fn running_as_root(dir: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(dir).unwrap().uid() == 0
    }

    #[test]
    fn an_unreadable_folder_marks_the_scan_incomplete_and_deletes_nothing() {
        let (dir, mut kernel) = workspace();
        if running_as_root(dir.path()) {
            return;
        }
        captured(&mut kernel, dir.path(), "notes/a.md");
        captured(&mut kernel, dir.path(), "top.md");
        let notes = dir.path().join("notes");
        let _locked = Mode::set(&notes, 0o000);

        let report = scan_workspace(&mut kernel).unwrap();

        assert!(!report.complete, "the walk did not see everything");
        assert_eq!(report.diagnostics, 1, "unreadable-dir");
        assert_eq!(report.absent_marked, 0, "an unseen document is not deleted");
    }

    #[test]
    fn an_unreadable_file_marks_the_scan_incomplete_and_is_not_deleted() {
        let (dir, mut kernel) = workspace();
        if running_as_root(dir.path()) {
            return;
        }
        captured(&mut kernel, dir.path(), "a.md");
        let file = dir.path().join("a.md");
        let _locked = Mode::set(&file, 0o000);

        let report = scan_workspace(&mut kernel).unwrap();

        assert!(!report.complete);
        assert_eq!(report.diagnostics, 1, "unreadable");
        assert_eq!(report.absent_marked, 0);
    }

    #[test]
    fn a_folder_readable_again_scans_complete() {
        let (dir, mut kernel) = workspace();
        if running_as_root(dir.path()) {
            return;
        }
        captured(&mut kernel, dir.path(), "notes/a.md");
        let notes = dir.path().join("notes");
        {
            let _locked = Mode::set(&notes, 0o000);
            assert!(!scan_workspace(&mut kernel).unwrap().complete);
        }

        let report = scan_workspace(&mut kernel).unwrap();

        assert!(report.complete);
        assert_eq!(report.absent_marked, 0);
    }
}
