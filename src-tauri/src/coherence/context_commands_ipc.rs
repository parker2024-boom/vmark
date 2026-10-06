//! The `#[tauri::command]` wrappers for the context surface.
//!
//! Split from `context_commands.rs` for the file-size gate, on the same seam
//! `commands.rs`/`commands_ipc.rs` already uses: this file is argument
//! marshalling and error typing only, while the `perform_*` functions it calls
//! — the real behaviour, and what the tests and the MCP bridge drive — stay in
//! the parent and keep their `String` errors.
//!
//! @coordinates-with context_commands.rs — the module this was split from
//! @module coherence/context_commands_ipc

use uuid::Uuid;

use super::blocking::with_kernel;
use super::command_errors::{
    classify_write, ledger_unavailable, rejected_argument, state_conflict,
};
use super::context_commands::{
    perform_branch_candidate, perform_context_create, perform_context_create_from_branch,
    perform_context_enforce, perform_contexts_list, BranchCandidate,
};
use super::context_types::{ContextReceipt, ContextRow};
use crate::command_error::CommandError;

#[tauri::command]
pub async fn coherence_branch_candidate<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
) -> Result<Option<BranchCandidate>, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // Read-only: inspects git + the context set, takes no argument to reject.
        perform_branch_candidate(kernel).map_err(ledger_unavailable)
    })
    .await
}

#[tauri::command]
pub async fn coherence_context_from_branch<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
) -> Result<ContextReceipt, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // Derives the name from the CURRENT branch, so a failure is workspace state
        // (detached HEAD, a name already taken) rather than a caller argument.
        perform_context_create_from_branch(kernel)
            .map_err(|e| classify_write(kernel, state_conflict, e))
    })
    .await
}

#[tauri::command]
pub async fn coherence_contexts<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
) -> Result<Vec<ContextRow>, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // Read-only projection of the manifests on disk.
        perform_contexts_list(kernel).map_err(ledger_unavailable)
    })
    .await
}

#[tauri::command]
pub async fn coherence_context_create<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    name: String,
    parent: Option<Uuid>,
) -> Result<ContextReceipt, CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // The caller supplies both the name and the parent id; a rejection means one
        // of them was wrong (empty/duplicate name, unknown or cyclic parent).
        perform_context_create(kernel, &name, parent)
            .map_err(|e| classify_write(kernel, rejected_argument, e))
    })
    .await
}

#[tauri::command]
pub async fn coherence_context_enforce<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_root: String,
    context: Uuid,
    enforcing: bool,
) -> Result<(), CommandError> {
    with_kernel(app, workspace_root, move |_state, kernel| {
        // `context` is a caller-supplied id that may not exist.
        perform_context_enforce(kernel, context, enforcing)
            .map_err(|e| classify_write(kernel, rejected_argument, e))
    })
    .await
}

#[cfg(test)]
#[path = "context_commands.test.rs"]
mod tests;
