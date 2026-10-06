//! A snapshot restore's claim on the runner (split from `state.rs` at the
//! file-size limit, beside `state_cancel.rs`).
//!
//! A restore writes the files a `save-file` step writes, so it takes the same
//! `running` flag a start takes, under the same admission lock — and releases
//! it through the same `AdmissionGuard`, never committed. It used to carry its
//! own RAII type and CAS in `snapshot_commands.rs`, a second copy of the
//! one transition this module's parent exists to keep in one place.
//!
//! It also keeps the spawn bookkeeping both claims share. `note_spawned`
//! (on `AdmissionGuard::commit`) records the last run that spawned, which
//! answers whether a snapshot is SUPERSEDED. `release_unspawned` (on an
//! uncommitted drop) releases the flag, the published id and the id's USE: a
//! start refused after its claim never ran, so its id is free for the retry.
//!
//! @coordinates-with workflow/state.rs — `AdmissionGuard`, the admission lock
//! @coordinates-with workflow/snapshot_commands.rs — the one caller
//! @module workflow::state_restore

use super::{AdmissionGuard, WorkflowRunnerState};
use crate::workflow::snapshots::snapshot_id_for;
use std::sync::atomic::Ordering;

impl WorkflowRunnerState {
    /// Claim `running` for a restore (WI-LX2.3), or `None` while a run or
    /// another restore holds it. Publishes NO execution id: a restore is not
    /// a run, so no cancel can name it and the engine-off transition does not
    /// mistake it for one. Dropping the guard releases the flag however
    /// the restore ends.
    pub(in crate::workflow) fn claim_for_restore(&self) -> Option<AdmissionGuard<'_>> {
        let _serial = self.admission_lock();
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(AdmissionGuard {
            state: self,
            committed: false,
        })
    }

    /// An admission dropped before spawning: forget the published id's
    /// use, then release the claim. `running` is still held while the id is
    /// read, so no other start can publish in between.
    pub(super) fn release_unspawned(&self) {
        let id = self
            .current_execution
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(id) = id {
            self.recent_ids.forget(&id);
        }
        self.clear_running();
    }

    /// Record the published run as spawned (`AdmissionGuard::commit`).
    pub(super) fn note_spawned(&self) {
        let id = self
            .current_execution
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(id) = id {
            self.recent_ids.note_spawned(id);
        }
    }

    /// Whether a run spawned after the one `snapshot_id` preserved, so its
    /// writes postdate the snapshot and a restore would undo them.
    /// Asked while the restore holds the claim: no run can spawn until it is
    /// released, so the answer cannot go stale before the restore runs. A
    /// snapshot from before this process spawned anything is not superseded
    /// by anything it knows of.
    pub(in crate::workflow) fn restore_superseded(&self, snapshot_id: &str) -> bool {
        self.recent_ids
            .last_spawned()
            .is_some_and(|id| snapshot_id_for(&id) != snapshot_id)
    }
}
