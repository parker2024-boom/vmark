//! The write lock for operations that must never CREATE a coherence workspace.
//!
//! `with_write_lock` creates `.vmark/` (and its `.gitignore` and `group.lock`)
//! before the operation is adjudicated — correct for an operation allowed to
//! initialize the workspace, wrong for one that is not. Capture-on-save OFF
//! (`CapturePolicy::TrackedOnly`) is the latter, and a pre-lock "is there a
//! ledger?" check cannot close it on its own: `.vmark/` deleted between that
//! check and the lock was recreated by the lock. Here the
//! lock itself declines when `.vmark/` is absent at the moment it is opened.
//!
//! `acquire_lock_file`, the creating lock `with_write_lock` takes, lives here
//! too, so both ways of taking the lock sit side by side.
//!
//! @coordinates-with state_write.rs — `run_locked`, the shared transaction body
//! @coordinates-with capture_policy.rs — the `TrackedOnly` caller
//! @module coherence/state_lock

use std::fs;
use std::path::Path;

use super::state::WorkspaceKernel;
use super::workspace_files::{ensure_lock_ignore_rules, flock_exclusive};

impl WorkspaceKernel {
    /// Open + exclusively `flock` the workspace lock file. The
    /// lock is held for the returned File's lifetime (released on fd close). The
    /// lock path is a permanently-ignored runtime file (never git-tracked, so a
    /// checkout can't swap its inode while held). Non-Unix skips the OS lock
    /// (best-effort; macOS/Linux are the gated platforms).
    pub(super) fn acquire_lock_file(&self) -> Result<fs::File, String> {
        let vmark = self.root().join(".vmark");
        fs::create_dir_all(&vmark).map_err(|e| format!("group lock dir: {e}"))?;
        // The ignore rules land with the LOCK, not with initialization (#1285)
        // — this path creates `.vmark/` before the op is adjudicated, and a
        // rejected op leaves it behind.
        ensure_lock_ignore_rules(&vmark)?;
        flock_exclusive(&vmark)
    }
    /// `with_write_lock` that never creates `.vmark/`: `Ok(None)` when it is
    /// absent at lock time, with nothing written anywhere. Re-entrant like
    /// `with_write_lock` (a nested call runs on the lock already held).
    pub fn with_existing_write_lock<R>(
        &mut self,
        f: impl FnOnce(&mut Self) -> Result<R, String>,
    ) -> Result<Option<R>, String> {
        self.ensure_available()?;
        if self.in_write_txn {
            return f(self).map(Some);
        }
        let Some(flock) = open_existing_lock(&self.root().join(".vmark"))? else {
            return Ok(None);
        };
        self.refused_for_short_read = false;
        self.run_locked(flock, f).map(Some)
    }
}

/// Lock an EXISTING `.vmark/`. `group.lock` may be created inside it (the
/// directory is already there); the directory itself never is. A directory
/// that vanishes between the check and the open surfaces as `NotFound` from
/// the open and is a decline, not an error.
fn open_existing_lock(vmark: &Path) -> Result<Option<fs::File>, String> {
    if !vmark.is_dir() {
        return Ok(None);
    }
    match flock_exclusive(vmark) {
        Ok(file) => Ok(Some(file)),
        Err(_) if !vmark.is_dir() => Ok(None),
        Err(e) => Err(e),
    }
}
