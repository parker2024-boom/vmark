//! Semantic-merge auditor mapping (Phase 5; ADR-C7). Composes the SP4
//! chain into one function: a completed merge's touched edges, derived
//! deterministically from the merge SHA. No new algorithm — it wires the git
//! diff, the registry inversion, and the index's `edges_affected_by` (ADR-P4).
//!
//! `merge SHA ─(git)▶ changed files ─(registry)▶ objects ─(index)▶ edges`
//!
//! The auditor then runs the **existing** checker over these edges
//! (reusing the Phase-1 `check_sweep` governance) and surfaces contradictions for
//! human resolution — it **never** auto-reconciles (§14).

use super::blocking::with_kernel;
use super::command_errors::ledger_unavailable;
use crate::command_error::CommandError;
use std::collections::HashMap;
use std::path::Path;

use super::gitops;
use super::index::CoherenceIndex;
use super::project::OriginEdge;
use super::types::ObjectId;

/// The edges a completed merge at `root`'s HEAD touched. Empty when HEAD is not
/// a merge. An unregistered changed file is skipped (a full impl emits a
/// diagnostic — the mapping stays total by never silently corrupting, only
/// omitting the unmapped). Deterministic + deduped (via `edges_affected_by`).
pub fn merge_affected_edges(
    index: &CoherenceIndex,
    root: &Path,
) -> Result<Vec<OriginEdge>, String> {
    let Some(sha) = gitops::merge_commit_sha(root) else {
        return Ok(Vec::new());
    };
    let files = gitops::merge_changed_files(root, &sha);
    if files.is_empty() {
        return Ok(Vec::new());
    }

    // Invert the registry (object→path) into path→object.
    let registry = index.registry_state()?;
    let by_path: HashMap<&str, ObjectId> = registry
        .path_of
        .iter()
        .map(|(obj, path)| (path.as_str(), *obj))
        .collect();

    let objects: Vec<ObjectId> = files
        .iter()
        .filter_map(|f| by_path.get(f.as_str()).copied())
        .collect();

    index.edges_affected_by(&objects)
}

/// One merge-affected edge, on the wire (read-only display).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAffectedEdge {
    pub txf: String,
    pub input: u32,
    pub upstream: ObjectId,
    pub downstream: ObjectId,
    pub kind: String,
}

/// The merge-affected edge set for the workspace's current HEAD (read-only,
/// MCP-safe — R23). Empty when HEAD is not a completed merge. The actual
/// re-check runs the existing checker over these edges (reusing the Phase-1
/// `check_sweep` governance); this command surfaces *which* edges a merge
/// touched, for the human/checker to act on — it never auto-reconciles (§14).
#[tauri::command]
pub async fn coherence_merge_audit<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
) -> Result<Vec<MergeAffectedEdge>, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        kernel.ensure_available().map_err(ledger_unavailable)?; // 9R-4: never serve a poisoned, half-rebuilt index
        let edges =
            merge_affected_edges(kernel.index(), kernel.root()).map_err(ledger_unavailable)?;
        Ok(edges
            .into_iter()
            .map(|e| MergeAffectedEdge {
                txf: e.txf.to_string(),
                input: e.input,
                upstream: e.upstream,
                downstream: e.downstream,
                kind: e.kind.as_str().to_string(),
            })
            .collect())
    })
    .await
}

#[cfg(test)]
#[path = "merge_audit.test.rs"]
mod tests;
