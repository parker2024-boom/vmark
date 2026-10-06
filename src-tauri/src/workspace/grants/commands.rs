//! The webview's re-grant command (WI-LX1.1): `allow_workspace_access`.
//!
//! Purpose: re-issue a grant the user already made — a recorded root, or a
//! folder inside one — and refuse everything else without saying why. The
//! folder pickers, which are how the user MAKES a grant, are `picker.rs`.
//!
//! Key decisions:
//!   - `async`, with its filesystem work on the blocking pool: a non-`async`
//!     command runs on the thread that delivered the IPC message, and
//!     `canonicalize` on a dead network mount blocks for the mount's timeout.
//!     At most `MAX_CONCURRENT_CHECKS` checks resolve at once,
//!     one per path, so a repeated call cannot drain the pool.
//!   - Going `async` removes the serialization the blocking IPC loop gave for
//!     free (rule 50 §10). The check-then-act here is "is it recorded? then
//!     grant": the list only grows except for oldest-first eviction, so a root
//!     evicted between the two steps was recorded a moment earlier, and the
//!     grant it gets is the one it already had.
//!   - No oracle: see `authorize`.
//!
//! @coordinates-with workspace/grants/mod.rs — the state and `canonical_dir`
//! @coordinates-with workspace/grants/scope.rs — the grant itself
//! @coordinates-with workspace/grants/picker.rs — the folder pickers
//! @coordinates-with services/workspaces/workspaceAccess.ts — the only caller
//! @module workspace/grants/commands

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use super::{scope, WorkspaceGrants};
use crate::command_error::{CommandError, ErrorCode};
use crate::localized_error;

/// Grant the fs + asset scopes again for a workspace root the user chose
/// before — the folder picker, Finder, or a recorded root from an earlier
/// launch — or for a folder inside one. Returns the canonical root.
///
/// Anything else is refused with `permission-denied` and extends nothing. A
/// folder the static capability scope already covers (under `$HOME`, say)
/// needs no grant; the caller tells the two apart by reading it. A grant that
/// does not take is an `internal` error, never a root. At most
/// `MAX_CONCURRENT_CHECKS` checks run at once, one per path (`begin_check`).
#[tauri::command]
pub async fn allow_workspace_access<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<String, CommandError> {
    let raw = PathBuf::from(path);
    if !raw.is_absolute() {
        return Err(not_absolute(&raw));
    }
    let check = app.state::<WorkspaceGrants>().begin_check(&raw)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _check = check;
        let root = authorize(&app.state::<WorkspaceGrants>(), &raw)?;
        scope::grant_workspace_scope(&app, &root)?;
        Ok(root)
    })
    .await
    .map_err(|e| CommandError::internal(format!("workspace access task failed: {e}")))?
}

fn not_absolute(raw: &Path) -> CommandError {
    CommandError::invalid_input(format!("'{}' is not absolute", raw.display()))
}

/// The decision behind [`allow_workspace_access`], without an app: the
/// canonical folder `raw` names, if it is a recorded root or inside one.
///
/// NO ORACLE: every path outside the recorded roots is refused with the same
/// error, naming the path as the caller spelled it — whether it exists, is a
/// file, or is a link, and wherever the link points. Only inside a chosen tree,
/// which the user has already opened to this window, is "gone" or "not a
/// folder" reported. What remains observable is TIMING: the path is resolved
/// before it is judged (a link's target decides), so a stale mount answers
/// slowly — bounded by `begin_check`.
pub(crate) fn authorize(grants: &WorkspaceGrants, raw: &Path) -> Result<String, CommandError> {
    if !raw.is_absolute() {
        return Err(not_absolute(raw));
    }
    let refused = || {
        localized_error!(
            ErrorCode::PermissionDenied,
            "errors.workspaceAccess.notGranted",
            path = raw.display()
        )
    };
    match raw.canonicalize() {
        Ok(real) => {
            let root = crate::canonical_path::canonical_string(&real, "workspace folder")
                .map_err(|_| refused())?;
            if !grants.covers(&root) {
                return Err(refused());
            }
            if !real.is_dir() {
                return Err(CommandError::invalid_input(format!(
                    "'{}' is not a folder",
                    raw.display()
                )));
            }
            Ok(root)
        }
        Err(e) if lies_inside_a_recorded_root(grants, raw) => Err(unresolvable(raw, &e)),
        Err(_) => Err(refused()),
    }
}

/// Would `raw`, which does not resolve, be inside a recorded root? Judged from
/// its nearest ancestor that does resolve, so `/var/…` spellings of a
/// `/private/var/…` root still count.
fn lies_inside_a_recorded_root(grants: &WorkspaceGrants, raw: &Path) -> bool {
    raw.ancestors()
        .skip(1)
        .find_map(|ancestor| {
            let real = ancestor.canonicalize().ok()?;
            let rest = raw.strip_prefix(ancestor).ok()?;
            crate::canonical_path::canonical_string(&real.join(rest), "workspace folder").ok()
        })
        .is_some_and(|candidate| grants.covers(&candidate))
}

/// The honest class of a resolution failure inside a chosen tree.
fn unresolvable(raw: &Path, e: &std::io::Error) -> CommandError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        _ => ErrorCode::Io,
    };
    CommandError::new(
        code,
        format!("'{}' could not be resolved: {e}", raw.display()),
    )
}

#[cfg(test)]
#[path = "commands.test.rs"]
mod tests;

#[cfg(test)]
#[path = "commands_policy.test.rs"]
mod policy_tests;
