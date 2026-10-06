//! The `#[tauri::command]` wrappers for the claim surface.
//!
//! Split from `claim_commands.rs` for the file-size gate, on the same seam
//! `commands.rs`/`commands_ipc.rs` already uses. The `perform_*` functions stay
//! in the parent with `String` errors — `mcp_bridge/coherence_answers.rs` calls
//! `perform_claims_list` directly and is itself a `String`-returning surface.
//!
//! @coordinates-with claim_commands.rs — the module this was split from
//! @module coherence/claim_commands_ipc

use uuid::Uuid;

use super::blocking::with_kernel;
use super::claim_commands::{
    perform_claim, perform_claim_scope, perform_claims_list, ClaimReceipt, ClaimRequest, ClaimRow,
};
use super::command_errors::{classify_write, ledger_unavailable, rejected_argument};
use crate::command_error::CommandError;

#[tauri::command]
pub async fn coherence_claim<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    request: ClaimRequest,
) -> Result<ClaimReceipt, CommandError> {
    let root = std::path::PathBuf::from(&workspace_root);
    with_kernel(app, workspace_root, move |_state, kernel| {
        let actor = super::commands::actor_identity(&root);
        // The request carries the claim statement, scope and maturity; a rejection
        // means one of those was wrong, so the caller must send something different.
        perform_claim(kernel, &request, &actor)
            .map_err(|e| classify_write(kernel, rejected_argument, e))
    })
    .await
}

#[tauri::command]
pub async fn coherence_claim_scope<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    context: Uuid,
    claim: Uuid,
    visible: bool,
) -> Result<(), CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // Both `context` and `claim` are caller-supplied ids that may not exist.
        perform_claim_scope(kernel, context, claim, visible)
            .map_err(|e| classify_write(kernel, rejected_argument, e))
    })
    .await
}

#[tauri::command]
pub async fn coherence_claims<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
) -> Result<Vec<ClaimRow>, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // Read-only. NOTE: `perform_claims_list` keeps its String error — the MCP
        // bridge (coherence_answers.rs) calls it directly and is still String-typed.
        perform_claims_list(kernel).map_err(ledger_unavailable)
    })
    .await
}

#[cfg(test)]
#[path = "claim_commands.test.rs"]
mod tests;
