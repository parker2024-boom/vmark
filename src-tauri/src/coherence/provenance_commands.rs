//! Provenance IPC surface + index queries (split from
//! `provenance.rs` for the file-size gate).

use super::blocking::with_kernel;
use super::command_errors::{classify_write, ledger_unavailable, rejected_argument};
use crate::command_error::CommandError;
use uuid::Uuid;

use super::provenance::{
    perform_confirm_inputs, perform_propose_inputs, perform_provenance_candidates, ConfirmReceipt,
    ConfirmRequest, Proposal, ProvenanceCandidate,
};
use super::types::{ObjectId, RevisionId};

#[tauri::command]
pub async fn coherence_provenance_candidates<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
) -> Result<Vec<ProvenanceCandidate>, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // Read-only sweep for orphaned-but-recoverable candidates.
        perform_provenance_candidates(kernel).map_err(ledger_unavailable)
    })
    .await
}

#[tauri::command]
pub async fn coherence_propose_inputs<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    path: String,
) -> Result<Proposal, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // `path` is caller-supplied and may name nothing the workspace tracks.
        perform_propose_inputs(kernel, &path).map_err(rejected_argument)
    })
    .await
}

#[tauri::command]
pub async fn coherence_confirm_inputs<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    request: ConfirmRequest,
) -> Result<ConfirmReceipt, CommandError> {
    let root = std::path::PathBuf::from(&workspace_root);
    with_kernel(app, workspace_root, move |_state, kernel| {
        let actor = super::commands::actor_identity(&root);
        // The request names the inputs to confirm; a rejection means the caller
        // must send a different set.
        perform_confirm_inputs(kernel, &request, &actor)
            .map_err(|e| classify_write(kernel, rejected_argument, e))
    })
    .await
}

impl super::index::CoherenceIndex {
    /// Any edges recorded at exactly this (object, revision)? D1 gates
    /// proposals on the head having none.
    pub(super) fn has_live_edges(
        &self,
        object: &ObjectId,
        rev: &RevisionId,
    ) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT 1 FROM edges WHERE downstream = ?1 AND downstream_rev = ?2 LIMIT 1",
                rusqlite::params![object.0.to_string(), rev.as_str()],
                |_| Ok(()),
            )
            .map(|_| true)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(false),
                other => Err(other.to_string()),
            })
    }

    /// The input set recorded at (object, revision) by its most recent
    /// transformation (UUIDv7 txf ids are time-ordered), roles intact.
    pub(super) fn inputs_recorded_at(
        &self,
        object: &ObjectId,
        rev: &RevisionId,
    ) -> Result<Vec<(ObjectId, String)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT upstream, role FROM edges
                 WHERE downstream = ?1 AND downstream_rev = ?2
                   AND txf = (SELECT MAX(txf) FROM edges
                              WHERE downstream = ?1 AND downstream_rev = ?2)
                 ORDER BY input_idx",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![object.0.to_string(), rev.as_str()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (obj, role) = row.map_err(|e| e.to_string())?;
            out.push((
                ObjectId(Uuid::parse_str(&obj).map_err(|e| e.to_string())?),
                role,
            ));
        }
        Ok(out)
    }
}
