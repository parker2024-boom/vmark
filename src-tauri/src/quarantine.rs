//! # Quarantine
//!
//! Purpose: Clear `com.apple.quarantine` xattr from a workspace root and its
//! direct children with a registered VMark extension, so subsequent Finder
//! opens are not silently dropped by macOS Launch Services /
//! CoreServicesUIAgent on running Tauri apps.
//!
//! Pipeline: frontend `openWorkspaceWithConfig` → `strip_workspace_quarantine`
//! command → root judged readable by the document windows → strips xattr on
//! root + depth-1 supported-format files → returns counts.
//!
//! Key decisions:
//!   - Only a folder the document windows can ALREADY read. The root comes
//!     from the webview, and clearing quarantine is a metadata write the fs
//!     scope does not mediate, so unchecked the command reached every folder
//!     on disk (an `.app` bundle is a folder). A root is accepted when it is a
//!     workspace the user granted, or lies inside the scope the app's
//!     capabilities give document windows (`webview_can_read`); anything else
//!     is refused and nothing is touched. What is judged is the CANONICAL
//!     folder, and that is also what is stripped, so a link cannot stand in
//!     for it.
//!   - Scope is bounded: root directory + direct supported-extension
//!     children only. No recursion. Keeps the operation predictable and
//!     fast on huge folders.
//!   - Links are not followed: the attribute is removed from the entry itself
//!     (`xattr::remove` does not dereference), so a link inside the workspace
//!     cannot aim the strip at a file outside it.
//!   - macOS-only. The xattr strip is a no-op on other platforms — the
//!     command exists on all platforms but returns an empty result so the
//!     frontend can call it unconditionally.
//!   - Best-effort: per-entry failures are logged and counted, never fatal.
//!     The workspace open must succeed even if quarantine cannot be cleared.
//!   - Registered-extension only: matches `SUPPORTED_EXTENSIONS` from the
//!     format registry. Phase 1B extended the scope from
//!     markdown-only so newly-supported formats reach the same Finder
//!     "Open With" guarantee.
//!
//! @coordinates-with workspace/grants/mod.rs — the workspace roots the user granted
//! @coordinates-with services/macos/macQuarantineNotice.ts — the only caller

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

use crate::command_error::CommandError;

#[cfg(target_os = "macos")]
const QUARANTINE_ATTR: &str = "com.apple.quarantine";

/// Result of a quarantine strip pass.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct StripStats {
    /// Number of entries that had `com.apple.quarantine` removed.
    pub stripped_count: usize,
    /// Number of entries that errored (logged; does not fail the call).
    pub error_count: usize,
}

/// Remove `com.apple.quarantine` from a single path. Returns `Ok(true)` if
/// the attribute was present and removed, `Ok(false)` if it was already
/// absent, `Err` only on unexpected I/O failures. A link is never followed:
/// the attribute is removed from the link itself.
#[cfg(target_os = "macos")]
fn strip_one(path: &Path) -> std::io::Result<bool> {
    match xattr::remove(path, QUARANTINE_ATTR) {
        Ok(()) => Ok(true),
        Err(e) => {
            // ENOATTR (93 on macOS) means the attribute wasn't there — not an error.
            if e.raw_os_error() == Some(93) {
                Ok(false)
            } else {
                Err(e)
            }
        }
    }
}

/// Strip `com.apple.quarantine` from `root` and every file with a
/// registered VMark extension (see `crate::has_supported_extension`)
/// directly inside `root`. Does not recurse into subdirectories.
///
/// Errors on individual entries are logged and counted, never propagated.
#[cfg(target_os = "macos")]
pub fn strip_workspace_quarantine(root: &Path) -> StripStats {
    let mut stats = StripStats::default();

    if !root.is_dir() {
        return stats;
    }

    match strip_one(root) {
        Ok(true) => stats.stripped_count += 1,
        Ok(false) => {}
        Err(e) => {
            stats.error_count += 1;
            log::warn!("[quarantine] strip root {:?} failed: {}", root, e);
        }
    }

    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            stats.error_count += 1;
            log::warn!("[quarantine] read_dir {:?} failed: {}", root, e);
            return stats;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !crate::has_supported_extension(&path) {
            continue;
        }
        match strip_one(&path) {
            Ok(true) => stats.stripped_count += 1,
            Ok(false) => {}
            Err(e) => {
                stats.error_count += 1;
                log::warn!("[quarantine] strip {:?} failed: {}", path, e);
            }
        }
    }

    if stats.stripped_count > 0 || stats.error_count > 0 {
        log::info!(
            "[quarantine] root={:?} stripped={} errors={}",
            root,
            stats.stripped_count,
            stats.error_count
        );
    }

    stats
}

/// Can the document windows already read `folder` (a canonical path)?
///
/// Yes when it is a workspace root the user granted, or a folder inside one
/// (`WorkspaceGrants`), or when the asset-protocol scope allows it. That scope
/// is the fs capability's static roots (`capabilities.test.rs` pins the two
/// equal) plus every runtime workspace grant, so it answers "is this inside
/// what the app's capabilities let a document window read" without a second,
/// hand-kept copy of those globs here.
#[cfg(target_os = "macos")]
fn webview_can_read<R: tauri::Runtime>(app: &tauri::AppHandle<R>, folder: &Path) -> bool {
    use tauri::Manager;
    let granted = folder.to_str().is_some_and(|canonical| {
        app.try_state::<crate::workspace::grants::WorkspaceGrants>()
            .is_some_and(|grants| grants.covers(canonical))
    });
    granted || app.asset_protocol_scope().is_allowed(folder)
}

/// The canonical folder `raw` names, if the webview may have it stripped.
///
/// NO ORACLE: a path that does not resolve and a folder the webview cannot
/// read are refused with the same error, naming the path as the caller
/// spelled it, so the command cannot be used to probe what exists outside the
/// webview's reach.
#[cfg(target_os = "macos")]
fn readable_workspace_root(
    raw: &Path,
    can_read: impl Fn(&Path) -> bool,
) -> Result<PathBuf, CommandError> {
    if !raw.is_absolute() {
        return Err(CommandError::invalid_input(format!(
            "'{}' is not absolute",
            raw.display()
        )));
    }
    match raw.canonicalize() {
        Ok(canonical) if can_read(&canonical) => Ok(canonical),
        _ => Err(crate::localized_error!(
            crate::command_error::ErrorCode::PermissionDenied,
            "errors.workspaceAccess.notGranted",
            path = raw.display()
        )),
    }
}

/// Tauri command. Strips quarantine from `root` and its direct children when
/// `root` is a folder the document windows can already read; anything else is
/// refused with `permission-denied` and nothing is touched.
///
/// `async`, with its filesystem work on the blocking pool: resolving `root`
/// can block for a dead network mount's timeout, which must not happen on the
/// thread that delivers IPC. It reads and writes no shared state.
///
/// On non-macOS, returns an empty `StripStats` so the frontend can call this
/// unconditionally without platform branches.
#[tauri::command]
pub async fn strip_workspace_quarantine_cmd<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
) -> Result<StripStats, CommandError> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let root =
                readable_workspace_root(Path::new(&root), |folder| webview_can_read(&app, folder))?;
            Ok(strip_workspace_quarantine(&root))
        })
        .await
        .map_err(|e| CommandError::internal(format!("quarantine task failed: {e}")))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, root);
        Ok(StripStats::default())
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "quarantine.test.rs"]
mod tests;
