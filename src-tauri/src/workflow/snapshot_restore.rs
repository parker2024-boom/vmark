//! The read side of workflow snapshots: list and restore (WI-LX2.3).
//!
//! Split from `snapshots.rs` at the file-size gate when the write side grew
//! its bounded, cancellable copy. Until WI-LX2.3 this half was
//! `#[allow(dead_code)]` with no command and no UI, while a run whose
//! snapshot failed was already REFUSED (`prepare.rs`) — a recovery
//! point nothing could recover from. `snapshot_commands.rs` now exposes both
//! functions, and the run panel offers the restore after a run.
//!
//! Three properties hold here:
//!   - The root is the one the snapshot RECORDED (`SnapshotInfo::
//!     workspace_root`), never a caller's. A snapshot without one predates
//!     restore and is refused rather than guessed at.
//!   - Every write and delete goes through `snapshot_write.rs`, anchored to
//!     the root held OPEN for the whole restore, so a parent — or
//!     the root itself — swapped for an escaping link is refused, not written
//!     or deleted through. A recorded path outside the root, or one carrying
//!     `..`, is skipped — metadata is not trusted, and it is read bounded and
//!     checked to name its own snapshot.
//!   - Per-file failures are COUNTED, not fatal: an undo that stops at the
//!     first bad file leaves the rest unrestored for no reason. The report
//!     says how many were restored, deleted and skipped.
//!
//! @coordinates-with snapshots.rs — `SnapshotInfo`, `validate_id`, the re-export
//! @coordinates-with snapshot_commands.rs — the Tauri commands
//! @coordinates-with snapshot_write.rs — the anchored write and delete
//! @module workflow::snapshot_restore

use super::snapshot_copy::MAX_SNAPSHOT_FILE_BYTES;
use super::snapshot_write::{delete_created, write_back, HeldRoot};
use super::snapshots::{validate_id, SnapshotInfo};
use crate::bounded_read::{read_regular_bounded, BoundedReadError};
use crate::command_error::{CommandError, ErrorCode};
use crate::localized_error;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

const MAX_SNAPSHOTS: usize = 50;
const SNAPSHOTS_DIR: &str = "workflow-snapshots";
/// Largest `metadata.json` a list or a restore reads. A record names at
/// most one path per save-file target of a run capped at 50 steps, so a real
/// one is a few kilobytes; it sits in app data and is read as hostile.
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

/// What the run panel needs to know about one snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub id: String,
    pub execution_id: String,
    pub timestamp: u64,
    /// Files that existed before the run and will be put back.
    pub file_count: usize,
    /// Files the run was about to create, deleted by a restore.
    pub created_count: usize,
}

/// What a restore did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: usize,
    pub deleted: usize,
    pub skipped: usize,
}

/// Why a snapshot's record did not load.
#[derive(Debug)]
pub(super) enum MetadataError {
    /// No `metadata.json`: not a snapshot, or one still being written.
    Missing,
    /// It is there and could not be read.
    Unreadable(std::io::Error),
    /// It was read and is not a record of THIS snapshot: over the cap, not a
    /// regular file, not a `SnapshotInfo`, or naming another snapshot.
    Invalid(String),
}

impl std::fmt::Display for MetadataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => write!(f, "no metadata.json"),
            Self::Unreadable(e) => write!(f, "metadata.json unreadable: {e}"),
            Self::Invalid(why) => write!(f, "metadata.json invalid: {why}"),
        }
    }
}

/// The ONE loader list, restore and retention share — they used to
/// read and parse separately, unbounded, and had already drifted on what a
/// read failure means. Bounded, since the record sits in app data and is read
/// as hostile; checked to name the directory it sits in, or the panel
/// could confirm one snapshot and restore another. The read is blocking, so
/// it runs on the blocking pool like every `read_regular_bounded` caller.
pub(super) async fn load_metadata(
    snapshot_dir: &Path,
    expected_id: &str,
) -> Result<SnapshotInfo, MetadataError> {
    let path = snapshot_dir.join("metadata.json");
    let raw = tokio::task::spawn_blocking(move || read_regular_bounded(&path, MAX_METADATA_BYTES))
        .await
        .map_err(|e| MetadataError::Unreadable(std::io::Error::other(e.to_string())))?
        .map_err(|e| match e {
            BoundedReadError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
                MetadataError::Missing
            }
            BoundedReadError::Io(e) => MetadataError::Unreadable(e),
            other => MetadataError::Invalid(other.to_string()),
        })?;
    let info: SnapshotInfo =
        serde_json::from_slice(&raw).map_err(|e| MetadataError::Invalid(e.to_string()))?;
    if info.id != expected_id {
        return Err(MetadataError::Invalid(format!(
            "the record names snapshot {:?}, not {expected_id:?}",
            info.id
        )));
    }
    Ok(info)
}

/// Put back every file `snapshot_id` preserved and delete the files the run
/// created, under the root the snapshot recorded.
pub async fn restore_snapshot(
    app_data_dir: &Path,
    snapshot_id: &str,
) -> Result<RestoreReport, CommandError> {
    validate_id(snapshot_id).map_err(CommandError::invalid_input)?;
    let snapshot_dir = app_data_dir.join(SNAPSHOTS_DIR).join(snapshot_id);
    let info = load_metadata(&snapshot_dir, snapshot_id)
        .await
        .map_err(|e| match e {
            MetadataError::Missing => {
                localized_error!(ErrorCode::NotFound, "errors.workflow.snapshotNotFound")
            }
            MetadataError::Unreadable(e) => localized_error!(
                ErrorCode::Io,
                "errors.workflow.snapshotUnreadable",
                detail = e
            ),
            MetadataError::Invalid(why) => localized_error!(
                ErrorCode::InvalidInput,
                "errors.workflow.snapshotUnreadable",
                detail = why
            ),
        })?;

    let Some(recorded_root) = info.workspace_root.clone() else {
        return Err(localized_error!(
            ErrorCode::Unsupported,
            "errors.workflow.snapshotNoWorkspace"
        ));
    };
    // Resolved ONCE and held open for the whole restore: every write and
    // delete below proves containment against this directory, not its name.
    let root = PathBuf::from(&recorded_root)
        .canonicalize()
        .map_err(|e| e.to_string())
        .and_then(HeldRoot::open)
        .map_err(|_| {
            localized_error!(
                ErrorCode::NotFound,
                "errors.workflow.snapshotWorkspaceMissing",
                path = recorded_root
            )
        })?;

    tokio::task::spawn_blocking(move || restore_blocking(&snapshot_dir, &info, &root))
        .await
        .map_err(|e| CommandError::internal(format!("snapshot restore task failed: {e}")))
}

/// The recorded path, if it is absolute, has no `..`, and lies strictly under `root`.
fn contained(recorded: &str, root: &Path) -> Result<PathBuf, String> {
    let path = PathBuf::from(recorded);
    let plain = path.components().all(|c| {
        matches!(
            c,
            Component::Normal(_) | Component::RootDir | Component::Prefix(_)
        )
    });
    if path.is_absolute() && plain && path.starts_with(root) && path != root {
        Ok(path)
    } else {
        Err("outside the snapshot's workspace".to_string())
    }
}

fn restore_blocking(snapshot_dir: &Path, info: &SnapshotInfo, root: &HeldRoot) -> RestoreReport {
    let mut report = RestoreReport::default();
    for recorded in &info.files {
        match restore_one(snapshot_dir, recorded, root) {
            Ok(()) => report.restored += 1,
            Err(reason) => {
                log::warn!("[workflow] not restoring {recorded:?}: {reason}");
                report.skipped += 1;
            }
        }
    }
    for recorded in &info.created_files {
        match contained(recorded, root.path()).and_then(|target| delete_created(&target, root)) {
            Ok(true) => report.deleted += 1,
            Ok(false) => {}
            Err(reason) => {
                log::warn!("[workflow] not deleting {recorded:?}: {reason}");
                report.skipped += 1;
            }
        }
    }
    report
}

fn restore_one(snapshot_dir: &Path, recorded: &str, root: &HeldRoot) -> Result<(), String> {
    let target = contained(recorded, root.path())?;
    let relative = target
        .strip_prefix(root.path())
        .map_err(|_| "outside the snapshot's workspace".to_string())?;
    let bytes = read_regular_bounded(&snapshot_dir.join(relative), MAX_SNAPSHOT_FILE_BYTES)
        .map_err(|e| format!("snapshot copy unreadable: {e}"))?;
    write_back(&target, root, &bytes)
}

/// Recent snapshots, newest first. A corrupt or unreadable entry is logged
/// and left out; a directory with no record yet is left out silently.
pub async fn list_snapshots(app_data_dir: &Path) -> Result<Vec<SnapshotSummary>, CommandError> {
    let snapshots_dir = app_data_dir.join(SNAPSHOTS_DIR);
    let mut dir = match tokio::fs::read_dir(&snapshots_dir).await {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(list_failed(e)),
    };

    let mut snapshots = Vec::new();
    while let Some(entry) = dir.next_entry().await.map_err(list_failed)? {
        // A snapshot is a real directory named by its id; anything else in
        // here (a stray file, a link) is not one.
        let is_dir = entry.file_type().await.is_ok_and(|t| t.is_dir());
        let name = entry.file_name();
        let (true, Some(id)) = (is_dir, name.to_str()) else {
            continue;
        };
        match load_metadata(&entry.path(), id).await {
            Ok(info) => snapshots.push(SnapshotSummary {
                file_count: info.files.len(),
                created_count: info.created_files.len(),
                id: info.id,
                execution_id: info.execution_id,
                timestamp: info.timestamp,
            }),
            Err(MetadataError::Missing) => {}
            Err(e) => log::warn!("[workflow] not listing snapshot {id:?}: {e}"),
        }
    }

    snapshots.sort_by_key(|s| std::cmp::Reverse(s.timestamp));
    snapshots.truncate(MAX_SNAPSHOTS);
    Ok(snapshots)
}

fn list_failed(e: std::io::Error) -> CommandError {
    localized_error!(
        ErrorCode::Io,
        "errors.workflow.snapshotListFailed",
        detail = e
    )
}

#[cfg(test)]
#[path = "snapshot_restore.test.rs"]
mod tests;
