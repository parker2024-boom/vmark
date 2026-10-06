// WI-RA7C.1 — a poisoned menu snapshot still resolves clicks and still takes
// updates. Each snapshot is replaced whole on every write, so a panic while it
// was held cannot have left it torn; dropping the click instead made "Open
// Recent" silently dead for the rest of the session.

use super::*;
use crate::lock_policy::tests::poison;
use std::sync::PoisonError;

/// Set `slot`, poison it, run `check`, and leave it unpoisoned for whichever
/// test reads it next.
fn with_poisoned(slot: &'static Mutex<Vec<String>>, entries: &[&str], check: impl FnOnce()) {
    *slot.lock().unwrap_or_else(PoisonError::into_inner) =
        entries.iter().map(|e| e.to_string()).collect();
    poison(slot);
    check();
    slot.clear_poison();
}

#[test]
fn a_poisoned_recent_files_snapshot_still_resolves_a_click() {
    with_poisoned(&RECENT_FILES_SNAPSHOT, &["/a.md", "/b.md"], || {
        assert_eq!(get_recent_file_path(1).as_deref(), Some("/b.md"));
        assert_eq!(get_recent_file_path(2), None, "out of range is still None");
    });
}

#[test]
fn a_poisoned_recent_workspaces_snapshot_still_resolves_a_click() {
    with_poisoned(&RECENT_WORKSPACES_SNAPSHOT, &["/ws"], || {
        assert_eq!(get_recent_workspace_path(0).as_deref(), Some("/ws"));
    });
}

#[test]
fn a_poisoned_genies_snapshot_still_resolves_a_click() {
    with_poisoned(&GENIES_SNAPSHOT, &["/g/polish.md"], || {
        assert_eq!(get_genie_path(0).as_deref(), Some("/g/polish.md"));
    });
}

#[test]
fn a_poisoned_snapshot_still_takes_a_replacement() {
    let slot = crate::lock_policy::tests::poisoned(vec!["old".to_string()]);
    replace_snapshot(&slot, vec!["new".to_string()]);
    assert_eq!(
        *slot.lock().unwrap_or_else(PoisonError::into_inner),
        vec!["new".to_string()]
    );
}
