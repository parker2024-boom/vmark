//! The recursive fs + asset-protocol grant for a workspace root (WI-LX1.1).
//!
//! Purpose: the widest grant the app makes — a runtime fs grant is accepted by
//! every fs command the capability permits, write and remove included — kept
//! behind the one module that decides a root was chosen. It lived in
//! `fs_scope.rs` as `allow_fs_read_dir`: `pub(crate)` and named "read", so
//! nothing enforced who could reach it and the name understated it.
//!
//! Key decisions:
//!   - STRICT. A scope that refuses the pattern, or a root that is still not
//!     readable afterwards, is an error, and the caller records nothing. Tauri
//!     escapes the path before compiling it as a glob, so the refusal is not
//!     expected to fire; the reachable case is a forbidden pattern, which
//!     outranks any allow (`fs_scope::grant_fs_read` makes the same assertion
//!     for single files).
//!   - CONFIRMED. Tauri resolves the name again while granting and also allows
//!     whatever it resolves to at that instant. A root swapped for a link
//!     between the caller's check and the grant would hand over the link's
//!     target, so the grant confirms afterwards that the root still resolves to
//!     itself, and a moved root is a failed grant: nothing is recorded or
//!     opened. The stray allow itself is NOT revoked — a forbid pattern would
//!     also revoke any workspace the user chose inside the target — so it
//!     lasts until restart (`fs_scope::confirm_grant_target` states the
//!     residual and what it takes to reach it).
//!
//! @coordinates-with workspace/grants/mod.rs — grant_chosen_root
//! @coordinates-with workspace/grants/commands.rs — allow_workspace_access
//! @coordinates-with workspace/grants/launch.rs — re-granting recorded roots
//! @coordinates-with fs_scope.rs — confirm_grant_target
//! @module workspace/grants/scope

use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

use crate::command_error::CommandError;

/// Grant `root` — a canonical folder the caller has already judged — to the fs
/// and asset-protocol scopes, recursively, and confirm the grant took.
pub(super) fn grant_workspace_scope<R: Runtime>(
    app: &AppHandle<R>,
    root: &str,
) -> Result<(), CommandError> {
    grant_then_confirm(app, root, allow_tree)
}

fn allow_tree<R: Runtime>(app: &AppHandle<R>, root: &str) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(root, true)
        .map_err(|e| format!("fs scope: {e}"))?;
    app.asset_protocol_scope()
        .allow_directory(root, true)
        .map_err(|e| format!("asset scope: {e}"))
}

/// [`grant_workspace_scope`] with the grant step injected, so a test can move
/// the root at the one moment a name-based check cannot guard.
fn grant_then_confirm<R: Runtime>(
    app: &AppHandle<R>,
    root: &str,
    grant: impl FnOnce(&AppHandle<R>, &str) -> Result<(), String>,
) -> Result<(), CommandError> {
    let failed = |e: String| CommandError::internal(format!("could not grant '{root}': {e}"));
    grant(app, root).map_err(failed)?;
    crate::fs_scope::confirm_grant_target(&root.to_owned(), || {
        super::canonical_dir(Path::new(root)).map_err(|e| e.message().to_owned())
    })
    .map_err(failed)?;
    if !(app.fs_scope().is_allowed(root) && app.asset_protocol_scope().is_allowed(root)) {
        return Err(failed("the scope did not take it".to_owned()));
    }
    Ok(())
}

#[cfg(test)]
#[path = "scope.test.rs"]
mod tests;
