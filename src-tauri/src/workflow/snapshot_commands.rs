//! Tauri commands for the snapshot read side (WI-LX2.3): list the pre-run
//! snapshots, and restore one.
//!
//! Key decisions:
//!   - **A restore holds the runner's `running` flag** for its whole length,
//!     claimed under the admission lock exactly like a start. A restore writes
//!     the files a `save-file` step writes, so the two must never overlap: a
//!     restore is refused (`conflict`) while a run is live, and a run is
//!     refused (`alreadyRunning`) while a restore is in progress.
//!   - **Not gated on `advanced.workflowEngine`** (rule 60 §12). A restore
//!     starts nothing; it undoes what a run did, the same class as
//!     `cancel_workflow`. A user who switches the engine off after a bad run
//!     must still be able to put their files back.
//!   - The id is the only argument. The root comes from the snapshot's own
//!     record (`snapshot_restore.rs`), so a caller cannot redirect a restore.
//!   - **A superseded snapshot is refused** (`conflict`): once a later
//!     run has spawned, it may have written files this snapshot predates, and
//!     restoring would undo that work. Checked under the claim, so the check
//!     and the restore are one step — the panel's own re-check cannot be.
//!
//! @coordinates-with snapshot_restore.rs — `restore_snapshot`, `list_snapshots`
//! @coordinates-with state.rs — `claim_for_restore`, the flag and its lock
//! @coordinates-with src/components/Editor/WorkflowPanel/workflowSnapshots.ts — the caller
//! @module workflow::snapshot_commands

use super::snapshot_restore::{list_snapshots, restore_snapshot, RestoreReport, SnapshotSummary};
use super::state::WorkflowRunnerState;
use crate::command_error::{CommandError, ErrorCode};
use crate::localized_error;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// The command's body against the managed state alone, so the exclusion
/// with a run is testable without a Tauri runtime.
pub(super) async fn restore_with_claim(
    state: &WorkflowRunnerState,
    app_data_dir: &Path,
    snapshot_id: &str,
) -> Result<RestoreReport, CommandError> {
    let _claim = state.claim_for_restore().ok_or_else(|| {
        localized_error!(ErrorCode::Conflict, "errors.workflow.restoreWhileRunning")
    })?;
    // Under the claim, so no run can spawn between this check and the writes.
    if state.restore_superseded(snapshot_id) {
        return Err(localized_error!(
            ErrorCode::Conflict,
            "errors.workflow.restoreSuperseded"
        ));
    }
    restore_snapshot(app_data_dir, snapshot_id).await
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path().app_data_dir().map_err(|e| {
        localized_error!(
            ErrorCode::Io,
            "errors.workflow.appDataDirUnavailable",
            detail = e
        )
    })
}

/// Recent pre-run snapshots, newest first.
#[tauri::command]
pub async fn list_workflow_snapshots(app: AppHandle) -> Result<Vec<SnapshotSummary>, CommandError> {
    list_snapshots(&app_data_dir(&app)?).await
}

/// Put back the files `snapshot_id` preserved and delete the ones its run
/// created. Refused while a workflow runs.
#[tauri::command]
pub async fn restore_workflow_snapshot(
    app: AppHandle,
    snapshot_id: String,
    state: State<'_, WorkflowRunnerState>,
) -> Result<RestoreReport, CommandError> {
    let dir = app_data_dir(&app)?;
    let report = restore_with_claim(&state, &dir, &snapshot_id).await?;
    log::info!(
        "[workflow] restored snapshot {snapshot_id:?}: {} restored, {} deleted, {} skipped",
        report.restored,
        report.deleted,
        report.skipped
    );
    Ok(report)
}

#[cfg(test)]
#[path = "snapshot_commands.test.rs"]
mod tests;
