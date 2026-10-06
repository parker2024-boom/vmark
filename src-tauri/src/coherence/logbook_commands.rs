//! Tauri surface for the coherence logbook (see `logbook.rs`).
//!
//! `coherence_logbook` is READ-ONLY — it projects the ledger, mints nothing.
//! `coherence_flag_judgment` is the single mutation: the owner's M2 relevance
//! judgment for one flagged edge, appended through the same workspace lock as
//! every other writer.

use super::blocking::with_kernel;
use super::command_errors::{ledger_unavailable, rejected_argument, state_conflict};
use crate::command_error::CommandError;
use serde::Serialize;
use uuid::Uuid;

use super::lifecycle::set_lifecycle;
use super::logbook::{append_flag_judgment, m2_summary, project_logbook, LogEntry, M2Summary};
use super::types::ObjectId;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogbookView {
    pub rows: Vec<LogEntry>,
    pub m2: M2Summary,
    /// Edges resolved more than once — the churn that drives M4's burden.
    /// Surfaced as its own count so "few edges, many times" is visible without
    /// the caller having to re-derive it from the rows.
    pub reopened_edges: usize,
}

/// Project the logbook for a workspace (read-only).
#[tauri::command]
pub async fn coherence_logbook<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
) -> Result<LogbookView, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        kernel.ensure_available().map_err(ledger_unavailable)?; // 9R-4: never serve a poisoned index
        let read = kernel.ledger().read_all().map_err(ledger_unavailable)?;
        let rows = project_logbook(&read.entries);
        let m2 = m2_summary(&rows);
        let reopened_edges = rows.iter().filter(|r| r.resolutions > 1).count();
        Ok(LogbookView {
            rows,
            m2,
            reopened_edges,
        })
    })
    .await
}

/// Record the owner's judgment of one flagged edge (the M2 datum).
#[tauri::command]
pub async fn coherence_flag_judgment<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    txf: Uuid,
    input: u32,
    judgment: String,
    note: Option<String>,
) -> Result<String, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        let id = append_flag_judgment(
            kernel,
            &txf,
            input,
            &judgment,
            note.as_deref().unwrap_or_default(),
        )
        .map_err(rejected_argument)?;
        Ok(id.to_string())
    })
    .await
}

/// Mark a document `frozen` (a finished record) or back to `live`.
/// design-lifecycle-and-anchors.md §A — human-set, never inferred.
#[tauri::command]
pub async fn coherence_set_lifecycle<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    object: Uuid,
    lifecycle: String,
    reason: Option<String>,
) -> Result<String, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        let id = set_lifecycle(
            kernel,
            &ObjectId(object),
            &lifecycle,
            reason.as_deref().unwrap_or_default(),
        )
        .map_err(rejected_argument)?;
        Ok(id.to_string())
    })
    .await
}

/// Anchor an edge to a heading path (empty clears it, restoring whole-file
/// behaviour). design-lifecycle-and-anchors.md §B.
#[tauri::command]
pub async fn coherence_set_anchor<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    txf: Uuid,
    input: u32,
    headings: Vec<String>,
) -> Result<String, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        let id = super::anchors::set_anchor(kernel, &txf, input, &headings)
            .map_err(rejected_argument)?;
        Ok(id.to_string())
    })
    .await
}

/// The heading paths this edge's upstream can be anchored to.
///
/// Reads the SAME text `set_anchor` validates against — the upstream's current
/// live revision. Sourcing the picker anywhere else (the working file, the
/// pinned revision) would let it offer paths the setter then rejects.
#[tauri::command]
pub async fn coherence_edge_headings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    txf: Uuid,
    input: u32,
) -> Result<Vec<Vec<String>>, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        kernel.ensure_available().map_err(ledger_unavailable)?; // 9R-4: never serve headings from a poisoned index
        let edge = kernel
            .index()
            .edge_by(&txf, input)
            .map_err(ledger_unavailable)?
            // The caller named an edge that is not there — an argument problem,
            // not a broken index.
            .ok_or_else(|| rejected_argument(format!("no such edge: {txf}#{input}")))?;
        let current = match kernel
            .index()
            .resolve_live(&edge.upstream)
            .map_err(ledger_unavailable)?
        {
            super::dag::Resolved::Single(rev) => rev,
            // A genuinely single upstream with no headings is the legitimate empty
            // case (Ok([]) below). A NON-single upstream is different: there is no
            // coherent revision to anchor against, and returning Ok([]) here would
            // render as "no sections to anchor to" — indistinguishable from a real
            // heading-less document. Surface the actual condition, with the same
            // wording set_anchor uses when it refuses for the same reason.
            _ => {
                return Err(state_conflict(
                    "upstream has no single live revision to anchor against".to_string(),
                ))
            }
        };
        let text = super::check_commands::snapshot_text(kernel, &edge.upstream, &current)
            .map_err(ledger_unavailable)?;
        Ok(super::anchors::heading_paths(&text))
    })
    .await
}

#[cfg(test)]
#[path = "logbook_commands.test.rs"]
mod tests;
