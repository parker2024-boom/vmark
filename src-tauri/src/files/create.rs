//! Claiming a new file name without touching an existing file.
//!
//! Purpose: `create_file_exclusive`, split out of `files/write.rs` (size gate)
//! when both writers moved onto a held folder. It shares that module's guard
//! and trust boundary: the webview names the path, so the workspace-grant list
//! is refused, judged on Unix by the identity of the folder the claim is made
//! in (`files/write/anchored.rs`) and on Windows by its canonical path.
//!
//! @coordinates-with files/write.rs — WriteAt, reject_unsafe_target, parent_missing
//! @coordinates-with workspace/grants/protect.rs — what counts as the list
//! @module files/create

use crate::command_error::{CommandError, ErrorCode};
use crate::files::write::{parent_missing, reject_unsafe_target, WriteAt};
use crate::localized_error;

/// Atomically claim `path` for a document that does not have one yet, without
/// ever touching an existing file.
///
/// Returns `true` when this call created the (empty) file, `false` when
/// something was already there.
///
/// Batch Save All used to build `folder/Untitled-1.md` and hand it straight to
/// the ordinary overwrite writer, so choosing a folder that already contained
/// that name silently replaced a document the user never opened.
/// Checking existence first and then writing would only narrow
/// the window, not close it: two windows saving concurrently, or anything else
/// creating the file in between, still lose bytes. `create_new(true)` is
/// `O_EXCL` / `CREATE_NEW`, so the claim and the test are one operation the
/// kernel serializes.
///
/// The empty file it leaves behind is the reservation. The caller writes the
/// real contents over it through the ordinary save path, which is an overwrite
/// of a file this batch owns.
///
/// Refuses the workspace-grant list: an empty claim there would make the list
/// unreadable. The check runs on where the claim is then made (`create_checked`).
#[tauri::command]
pub async fn create_file_exclusive<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<bool, CommandError> {
    tokio::task::spawn_blocking(move || {
        create_checked(std::path::Path::new(&path), |at| at.refuse_grant_list(&app))
    })
    .await
    .map_err(|e| {
        localized_error!(
            ErrorCode::Internal,
            "errors.save.taskFailed",
            detail = e.to_string()
        )
    })?
}

/// The synchronous claim core, testable without a runtime: validate `target`
/// (the same trust boundary as a write), let `authorize` judge where the claim
/// lands, and claim exactly there. `O_EXCL` never follows a link at the name.
pub(crate) fn create_checked(
    target: &std::path::Path,
    authorize: impl FnOnce(&WriteAt<'_>) -> Result<(), CommandError>,
) -> Result<bool, CommandError> {
    reject_unsafe_target(target)?;
    let dir = target.parent().unwrap_or(target);
    let write_failed = |e: std::io::Error| {
        localized_error!(
            ErrorCode::Io,
            "errors.save.writeFailed",
            detail = e.to_string()
        )
    };
    let Some(name) = target.file_name() else {
        return Err(localized_error!(
            ErrorCode::InvalidInput,
            "errors.save.noParentDirectory"
        ));
    };
    let created = claim(target, dir, name, authorize)?;
    match created {
        Ok(()) => Ok(true),
        // Already taken — including by a symlink, which `O_EXCL` refuses
        // rather than following. The caller moves to the next candidate name.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(parent_missing(dir)),
        Err(e) => Err(write_failed(e)),
    }
}

/// Unix: the folder is held open, judged by identity, and the claim made in it.
#[cfg(unix)]
fn claim(
    target: &std::path::Path,
    dir: &std::path::Path,
    name: &std::ffi::OsStr,
    authorize: impl FnOnce(&WriteAt<'_>) -> Result<(), CommandError>,
) -> Result<std::io::Result<()>, CommandError> {
    let held = match crate::files::write::anchored::HeldDir::open(dir) {
        Ok(held) => held,
        Err(e) => return Ok(Err(e)),
    };
    authorize(&WriteAt::new(target, &held))?;
    Ok(held.create_new(name).map(|_| ()))
}

/// Windows: resolved once to a canonical folder, judged, and claimed there by
/// path (no `openat` in std; `files/write/anchored.rs` states the residual).
#[cfg(not(unix))]
fn claim(
    _target: &std::path::Path,
    dir: &std::path::Path,
    name: &std::ffi::OsStr,
    authorize: impl FnOnce(&WriteAt<'_>) -> Result<(), CommandError>,
) -> Result<std::io::Result<()>, CommandError> {
    let claim = match dir.canonicalize() {
        Ok(real) => real.join(name),
        Err(e) => return Ok(Err(e)),
    };
    authorize(&WriteAt::new(&claim))?;
    Ok(std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&claim)
        .map(|_| ()))
}
