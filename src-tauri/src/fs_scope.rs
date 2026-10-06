//! Runtime extension of the fs + asset-protocol scopes.
//!
//! The STATIC capability scope (`capabilities/default.json`, plus C:–F: in
//! `windows.json`) covers `$HOME/**`, `/Volumes/**`, `/mnt/**` and `/media/**`,
//! and the asset-protocol scope in `tauri.conf.json` is narrowed to the same
//! roots (WI-LX1.2). Anything the user opens from outside them — a file from
//! Finder or the CLI, a workspace on another drive — is granted here at runtime.
//!
//! Four properties of these grants drive every caller:
//!   - they are IN-MEMORY and do not survive a restart, so a path must be
//!     re-granted on every launch that opens it, not once when it is first
//!     picked;
//!   - `allow_file` grants exactly one path, while `allow_directory(p, r)`
//!     pushes `p/*` when `r` is false and `p/**` when true — so a workspace
//!     needs the recursive form or its subdirectories stay out of scope;
//!   - a runtime fs grant is NOT read-only: the fs plugin accepts a
//!     runtime-granted path for every command the capability permits (write,
//!     rename, remove). The recursive workspace grant therefore lives in
//!     `workspace/grants/scope.rs`, private to the module that decides a root
//!     was chosen, never here;
//!   - Tauri resolves a granted name AGAIN while granting, and also allows
//!     whatever it resolves to then (`confirm_grant_target`).
//!
//! Split out of `files/open.rs` when that file crossed the 300-line limit:
//! granting scope is a separate concern from queueing Finder/CLI opens.
//!
//! @coordinates-with files/open.rs — queues the opens these grants make readable
//! @coordinates-with workspace/grants/scope.rs — the recursive workspace grant
//! @coordinates-with asset_access.rs — the media grant, confirmed the same way

use tauri::Manager;

/// Runtime-extend the fs + asset scopes for a path the user asked to open.
/// Files from Finder / CLI / "open in new window" can live anywhere
/// (`/private/tmp`, `/etc`), so `readTextFile` rejects them until extended
/// here. The asset-protocol scope is limited to the same static roots, so it
/// needs the same per-file grant for `convertFileSrc`/asset:// to serve the
/// file (inline images + media viewer). Best-effort: failures logged, not
/// propagated.
pub(crate) fn allow_fs_read<R: tauri::Runtime, P: AsRef<std::path::Path>>(
    app: &tauri::AppHandle<R>,
    path: P,
) {
    use tauri_plugin_fs::FsExt;
    let path = path.as_ref();
    if let Err(e) = app.fs_scope().allow_file(path) {
        log::warn!("[fs-scope] Failed to allow file {:?}: {}", path, e);
    }
    if let Err(e) = app.asset_protocol_scope().allow_file(path) {
        log::warn!("[asset-scope] Failed to allow file {:?}: {}", path, e);
    }
}

/// [`allow_fs_read`], reporting whether `path` ended up READABLE.
///
/// `allow_fs_read` is best-effort by design — it logs a failed grant and
/// returns — which is right for the Finder/CLI callers, where the static scope
/// often covers the file anyway and refusing the open would turn a partial
/// degradation into a hard failure. It is wrong for `open_*_in_new_window`,
/// whose entire job is to make this file readable in the window it is about to
/// build: the command reported success, the window opened, and the webview's
/// first read came back `forbidden path`.
///
/// **This is an ASSERTION, and it is measured as never firing today.** Both
/// `Scope::allow_file` calls return `Result`, but Tauri escapes each granted
/// path before compiling it as a glob, so the obvious failure — a filename
/// holding `[` or `*` — grants fine (`fs_scope.test.rs` pins that). The check
/// stays because the failure it guards is otherwise INVISIBLE: nothing else
/// distinguishes "granted" from "logged and carried on", and the symptom
/// surfaces a window later as an error the user cannot act on.
///
/// The verdict is the RUNTIME scope's `is_allowed`, not the grant's own
/// `Result`. That scope starts empty (the fs plugin builds it from
/// `FsScope::default()`) and never sees the capability files, so the check
/// answers exactly "did a runtime pattern take?".
pub(crate) fn grant_fs_read<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    allow_fs_read(app, path);
    if app.fs_scope().is_allowed(path) {
        Ok(())
    } else {
        Err(format!(
            "{path} could not be added to the file-read scope, so a window opened on it \
             would be refused every read"
        ))
    }
}

/// Confirm, after a grant, that a name still resolves to the target the caller
/// judged.
///
/// `Scope::allow_file` / `allow_directory` resolve the name they are given
/// AGAIN and also allow whatever it resolves to at that instant: tauri 2.11.5's
/// `push_pattern` (`src/scope/fs.rs:92`) ends by inserting
/// `canonicalize_parent(path)` (`:143`), and `allow_directory` (`:351`) and
/// `allow_file` both go through it. A caller that resolved and judged the
/// target a moment earlier is exposed to a swap in between. This resolves once
/// more after the grant and reports a moved name as a FAILED grant, so the
/// caller records nothing and opens nothing.
///
/// What it deliberately does NOT do is undo the stray grant. Tauri has no call
/// that removes an allow pattern, and the only counter — a forbid pattern —
/// outranks every allow, including ones the user made: a swap aimed at a
/// workspace the user chose, or at a folder containing one, would have that
/// workspace revoked. So the residual is stated, not papered over: after a
/// swap that lands inside one grant call, the target stays readable (and, for
/// the fs scope, writable) until the app restarts. It needs a rename of an
/// EXISTING link into place during that call — no fs-plugin command creates
/// one — and a swap undone before this check runs is invisible to any check
/// made by name.
pub(crate) fn confirm_grant_target<T: PartialEq + std::fmt::Debug>(
    judged: &T,
    resolve_again: impl FnOnce() -> Result<T, String>,
) -> Result<(), String> {
    let now = resolve_again()?;
    if now == *judged {
        return Ok(());
    }
    log::error!("[fs-scope] {judged:?} resolved to {now:?} while it was being granted");
    Err(format!(
        "{judged:?} resolved to {now:?} while it was being granted"
    ))
}

#[cfg(test)]
#[path = "fs_scope.test.rs"]
mod tests;
