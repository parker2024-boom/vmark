//! Keeping webview-supplied writes off the grant list (WI-LX1.1).
//!
//! Purpose: the list decides what is granted at the next launch, so a generic
//! write command that lets the webview name a path must not reach it. This is
//! the predicate those commands share; they call [`refuse_list_write`] with the
//! path they are about to write, and with its link-resolved referent.
//!
//! Key decisions:
//!   - Matching is by IDENTITY first, then by FOLDER and NAME. Any spelling
//!     that resolves to the existing list is the list — a link, and on Windows
//!     an 8.3 short name. Otherwise the folders are compared after
//!     `canonicalize` (so a linked folder, `/var` vs `/private/var`, or a
//!     differently-cased folder is caught), and the name as Win32 opens it:
//!     ignoring ASCII case, cut at a stream `:`, trailing dots and spaces
//!     dropped. Over-refusing `WORKSPACE-GRANTS.JSON.` on a case-sensitive
//!     Linux disk costs nothing.
//!   - A HELD folder (Unix saves, `files/write/anchored.rs`) is judged by its
//!     identity instead of its path (`held_write_reaches_list`).
//!   - FAIL CLOSED, in the identity check and the folder check alike. Only
//!     "nothing is there" (no such file or folder, or a link loop, which
//!     resolves to nothing) is a non-match. Anything that exists but cannot be
//!     resolved — permission, I/O, anything else — is refused: an error is not
//!     evidence the write misses the list, and a target that cannot be
//!     resolved might be an alias of it whatever it is called. The cost is a
//!     `listProtected` refusal for a write that would have failed anyway.
//!   - The list's location comes from the state launch adopted, or — before
//!     launch, or if the state is not managed at all — from the app data
//!     directory launch WILL read. A registration or setup regression cannot
//!     switch the protection off; an app data directory that cannot be
//!     resolved refuses the write instead.
//!   - Link resolution is the caller's (`files/write.rs`, the one place that
//!     follows document links); this module only compares.
//!   - WHAT A PATH CHECK CANNOT HOLD: a verdict on a path is
//!     about the path at that instant. The generic writers therefore also
//!     judge the folder they HOLD open and write through
//!     (`held_write_reaches_list`, `files/write/anchored.rs`), which a later
//!     swap cannot redirect; on Windows they stay path-based. A workflow
//!     root is judged by path here (`root_contains_list`) — once on the
//!     caller's string and again on the admitted canonical root
//!     (`workflow/commands.rs`) — and a root renamed and replaced by a link
//!     after that is the workflow engine's to hold, not this module's.
//!
//! @coordinates-with files/write.rs — atomic_write_file
//! @coordinates-with files/create.rs — create_file_exclusive
//! @coordinates-with workflow/commands.rs — run_workflow refuses a root containing the list
//! @coordinates-with workspace/grants/mod.rs — where the list file lives
//! @module workspace/grants/protect

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use super::{WorkspaceGrants, GRANTS_FILE};
use crate::command_error::{CommandError, ErrorCode};
use crate::localized_error;

/// "Nothing is there": the one resolution failure that is not a refusal. A
/// link loop counts — it resolves to no file, so it cannot be the list — and
/// is left for the save to report as the loop it is.
fn is_absent(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ELOOP) {
        return true;
    }
    matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

/// The FILE a name opens under Win32: cut at the first `:` (NTFS stream
/// syntax — `list::$DATA` is the list's contents, `list:x` a stream on it),
/// then trailing dots and spaces dropped. Applied everywhere: over-refusing
/// such a name on a disk that allows it costs nothing.
fn win32_name(name: &OsStr) -> String {
    let name = name.to_string_lossy();
    let file = name.split(':').next().unwrap_or_default();
    file.trim_end_matches(['.', ' ']).to_owned()
}

/// Resolve two folders for comparison: `Some` when both resolved, `None` when
/// either is absent (a non-match), `Err` when either could not be resolved.
fn resolve_pair(a: &Path, b: &Path) -> Result<Option<(PathBuf, PathBuf)>, ()> {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => Ok(Some((a, b))),
        (Err(e), _) | (_, Err(e)) if !is_absent(&e) => Err(()),
        _ => Ok(None),
    }
}

/// Does writing `target` write the list file `list`?
pub(crate) fn names_grant_list(list: &Path, target: &Path) -> bool {
    match resolve_pair(target, list) {
        Ok(Some((target, list))) if target == list => return true,
        Err(()) => return true,
        _ => {}
    }
    let (Some(name), Some(list_name)) = (target.file_name(), list.file_name()) else {
        return false;
    };
    if !win32_name(name).eq_ignore_ascii_case(&win32_name(list_name)) {
        return false;
    }
    let (Some(dir), Some(list_dir)) = (target.parent(), list.parent()) else {
        return false;
    };
    match resolve_pair(dir, list_dir) {
        Ok(Some((dir, list_dir))) => dir == list_dir,
        Ok(None) => false,
        Err(()) => true,
    }
}

/// Does writing `name` inside a HELD folder write the list? Judged by identity
/// — the held folder's (device, inode) and the existing entry's, not following
/// a link — so a folder on the path swapped after the check cannot redirect
/// the write (`files/write/anchored.rs`). An identity that could not be read is
/// refused, like every other resolution failure here.
#[cfg(unix)]
pub(crate) fn held_write_reaches_list(
    list: &Path,
    held_dir: std::io::Result<(u64, u64)>,
    name: &OsStr,
    entry: std::io::Result<Option<(u64, u64)>>,
) -> bool {
    use std::os::unix::fs::MetadataExt;
    let identity = |p: &Path| std::fs::metadata(p).map(|m| (m.dev(), m.ino()));
    let (Ok(held_dir), Ok(entry)) = (held_dir, entry) else {
        return true;
    };
    match identity(list) {
        Ok(list) if entry == Some(list) => return true,
        Err(e) if !is_absent(&e) => return true,
        _ => {}
    }
    let (Some(list_name), Some(list_dir)) = (list.file_name(), list.parent()) else {
        return false;
    };
    if !win32_name(name).eq_ignore_ascii_case(&win32_name(list_name)) {
        return false;
    }
    match identity(list_dir) {
        Ok(list_dir) => list_dir == held_dir,
        Err(e) => !is_absent(&e),
    }
}

/// Does a workspace rooted at `root` contain the list file `list`?
///
/// Compared after `canonicalize`, so a root that is a link to an ancestor of
/// app data is caught. A root that does not exist contains nothing; one that
/// exists but cannot be resolved is treated as containing it.
pub(crate) fn root_contains_list(list: &Path, root: &Path) -> bool {
    let Some(list_dir) = list.parent() else {
        return false;
    };
    match resolve_pair(list_dir, root) {
        Ok(Some((list_dir, root))) => list_dir.starts_with(root),
        Ok(None) => false,
        Err(()) => true,
    }
}

/// Where the list lives: the file launch adopted, else where launch will look.
pub(crate) fn list_location<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CommandError> {
    if let Some(file) = app
        .try_state::<WorkspaceGrants>()
        .and_then(|grants| grants.list_file())
    {
        return Ok(file);
    }
    crate::app_paths::app_data_dir(app)
        .map(|dir| dir.join(GRANTS_FILE))
        .map_err(|e| {
            CommandError::internal(format!(
                "cannot locate the workspace-grant list, so the write is refused: {e}"
            ))
        })
}

/// Refuse with a typed, localized `permission-denied` when `reaches_list`
/// holds for the list's location. The one guard both entry points share.
fn refuse_if<R: Runtime>(
    app: &AppHandle<R>,
    reaches_list: impl FnOnce(&Path) -> bool,
) -> Result<(), CommandError> {
    if reaches_list(&list_location(app)?) {
        return Err(localized_error!(
            ErrorCode::PermissionDenied,
            "errors.workspaceAccess.listProtected"
        ));
    }
    Ok(())
}

/// Refuse a workspace root that contains the list — a workflow run is bounded
/// by its root, so such a root would let an `action/save-file` step rewrite
/// the list (WI-LX1.1 follow-up).
pub(crate) fn refuse_root_containing_list<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
) -> Result<(), CommandError> {
    refuse_if(app, |list| root_contains_list(list, root))
}

/// Refuse a write of `name` into a held folder that would land on the list.
#[cfg(unix)]
pub(crate) fn refuse_held_write<R: Runtime>(
    app: &AppHandle<R>,
    held_dir: std::io::Result<(u64, u64)>,
    name: &OsStr,
    entry: std::io::Result<Option<(u64, u64)>>,
) -> Result<(), CommandError> {
    refuse_if(app, |list| {
        held_write_reaches_list(list, held_dir, name, entry)
    })
}

/// Refuse a webview-supplied write to `target` if it would land on the list.
pub(crate) fn refuse_list_write<R: Runtime>(
    app: &AppHandle<R>,
    target: &Path,
) -> Result<(), CommandError> {
    refuse_if(app, |list| names_grant_list(list, target))
}

#[cfg(test)]
#[path = "protect.test.rs"]
mod tests;
