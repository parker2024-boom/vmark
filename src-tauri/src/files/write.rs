//! Atomic file write for the frontend save path.
//!
//! Purpose: temp-file + fsync + rename atomic write, exposed as the
//! `atomic_write_file` Tauri command. Extracted from `lib.rs` verbatim to
//! keep that file under the size gate.
//!
//! NOTE: A separate sync variant exists in `app_paths::atomic_write_file` for
//! internal use (workspace config, MCP port file). Both are thin wrappers
//! over the shared `atomic_replace` core; they stay separate commands because
//! this one is async for the frontend invoke path and carries frontend-only
//! validation and error semantics.
//!
//! This was the first command migrated to [`CommandError`]. The
//! parent-directory failure used to travel as a `"PARENT_MISSING:"` string
//! prefix that `saveToPath.ts` re-parsed — a cross-language contract held
//! together by a comment in each file asking the reader to keep the other in
//! sync. It is now `code: "not-found"` with the directory in `detail.dir`, and
//! every message here resolves through `t!` instead of being raw English that
//! `lint:i18n` could not see.
//!
//! WI-LX1.1: this command and `files::create::create_file_exclusive` let the
//! webview name a path, so both refuse the workspace-grant list — the folders
//! re-granted at the next launch. The path is RESOLVED ONCE and the check runs
//! on what it resolved to ([`WriteAt`]). On Unix the folder is then HELD open,
//! judged by identity, and written through (`files/write/anchored.rs`), so a
//! folder on the path swapped after the check cannot redirect the write. On
//! Windows the write stays path-based; that module states the residual.
//!
//! @coordinates-with workspace/grants/protect.rs — what counts as the list
//! @coordinates-with files/write/anchored.rs — the held-folder write (Unix)
//! @coordinates-with files/create.rs — the exclusive create, same guard

use crate::command_error::{CommandError, ErrorCode};
use crate::localized_error;
use serde_json::json;

#[cfg(unix)]
pub(crate) mod anchored;

/// Where a checked write lands, as the list guard judges it: the resolved
/// path, and on Unix the folder held open for the write itself.
pub(crate) struct WriteAt<'a> {
    path: &'a std::path::Path,
    #[cfg(unix)]
    held: &'a anchored::HeldDir,
}

impl<'a> WriteAt<'a> {
    #[cfg(unix)]
    pub(crate) fn new(path: &'a std::path::Path, held: &'a anchored::HeldDir) -> Self {
        Self { path, held }
    }

    #[cfg(not(unix))]
    pub(crate) fn new(path: &'a std::path::Path) -> Self {
        Self { path }
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &std::path::Path {
        self.path
    }

    /// Refuse a write here that would land on the workspace-grant list: by
    /// path, and on Unix by the held folder's identity — the check that binds.
    pub(crate) fn refuse_grant_list<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
    ) -> Result<(), CommandError> {
        crate::workspace::grants::refuse_list_write(app, self.path)?;
        #[cfg(unix)]
        if let Some(name) = self.path.file_name() {
            crate::workspace::grants::refuse_held_write(
                app,
                self.held.identity(),
                name,
                self.held.entry_identity(name),
            )?;
        }
        Ok(())
    }
}

/// [`write_checked`] with nothing to authorize — the write core's own
/// behaviour, for tests that do not need an app.
#[cfg(test)]
pub(crate) fn atomic_write_file_sync(
    target: &std::path::Path,
    content: &str,
) -> Result<(), CommandError> {
    write_checked(target, content, |_| Ok(()))
}

/// Refuse what no write command accepts: a `..` component (defense-in-depth,
/// if the webview is compromised) or a relative path.
pub(crate) fn reject_unsafe_target(target: &std::path::Path) -> Result<(), CommandError> {
    if target
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return Err(localized_error!(
            ErrorCode::InvalidInput,
            "errors.core.pathTraversal"
        ));
    }
    if !target.is_absolute() {
        return Err(localized_error!(
            ErrorCode::InvalidInput,
            "errors.core.pathNotAbsolute"
        ));
    }
    Ok(())
}

/// The write core: validate `target`, resolve it ONCE to its referent, let
/// `authorize` judge where the write lands ([`WriteAt`]), and write exactly
/// there — never resolving the name again, so a link swapped in at it is
/// replaced by the rename, not followed.
///
/// The referent is resolved BEFORE choosing a directory. A save writes a temp
/// file and renames it, and renaming onto a symlink replaces the LINK — the
/// alias stops being an alias and the real document keeps its old bytes, while
/// the save reports success. The temp file is created in
/// the REFERENT's directory too, or the rename crosses filesystems.
pub(crate) fn write_checked(
    target: &std::path::Path,
    content: &str,
    authorize: impl FnOnce(&WriteAt<'_>) -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    use crate::atomic_replace::resolve_link_target;

    reject_unsafe_target(target)?;
    let resolved = resolve_link_target(target).map_err(link_failure)?;
    let (Some(dir), Some(name)) = (resolved.parent(), resolved.file_name()) else {
        return Err(localized_error!(
            ErrorCode::InvalidInput,
            "errors.save.noParentDirectory"
        ));
    };
    #[cfg(unix)]
    {
        // A structured error when the folder is gone (renamed or deleted while
        // the file was open): the frontend reads `code` + `detail.dir` to route
        // the user into Save As.
        let held = anchored::HeldDir::open(dir).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => parent_missing(dir),
            _ => localized_error!(
                ErrorCode::Io,
                "errors.save.writeFailed",
                detail = e.to_string()
            ),
        })?;
        authorize(&WriteAt::new(&resolved, &held))?;
        held.replace(name, content.as_bytes())
            .map_err(|stage| stage_failure(dir, stage))
    }
    #[cfg(not(unix))]
    {
        let _ = name;
        authorize(&WriteAt::new(&resolved))?;
        write_resolved(&resolved, dir, content)
    }
}

/// The folder a save would land in is gone.
pub(crate) fn parent_missing(dir: &std::path::Path) -> CommandError {
    localized_error!(
        ErrorCode::NotFound,
        "errors.save.parentMissing",
        dir = dir.display()
    )
    .with_detail(json!({ "dir": dir.to_string_lossy() }))
}

/// Localize a held-folder write failure with the same `detail.stage` the
/// path-based core reports, so the frontend sees one error shape.
#[cfg(unix)]
fn stage_failure(dir: &std::path::Path, stage: anchored::Stage) -> CommandError {
    use anchored::Stage;
    let (stage, error) = match stage {
        Stage::CreateTemp(e) => ("create-temp", e),
        Stage::WriteTemp(e) => ("write-temp", e),
        Stage::SyncTemp(e) => ("sync-temp", e),
        Stage::Persist(e) => ("persist", e),
    };
    let mut detail = json!({ "kind": "atomic-replace", "stage": stage });
    if stage == "create-temp" {
        detail["parent"] = json!(dir.display().to_string());
    }
    localized_error!(
        ErrorCode::Io,
        "errors.save.writeFailed",
        detail = error.to_string()
    )
    .with_detail(detail)
}

/// Write `target`, whose links are already resolved, through its path
/// (Windows: no `openat`/`renameat` in std — see `files/write/anchored.rs`).
#[cfg(not(unix))]
fn write_resolved(
    target: &std::path::Path,
    dir: &std::path::Path,
    content: &str,
) -> Result<(), CommandError> {
    use crate::atomic_replace::atomic_replace;
    if !dir.is_dir() {
        return Err(parent_missing(dir));
    }
    atomic_replace(target, dir, content.as_bytes()).map_err(save_failure)?;
    // Best-effort: the file itself is already synced and persisted.
    if let Ok(dir_file) = std::fs::File::open(dir) {
        if let Err(e) = dir_file.sync_all() {
            log::warn!(
                "Failed to sync parent directory {:?} after atomic write: {}",
                dir,
                e
            );
        }
    }
    Ok(())
}

/// Localize a symlink-resolution failure. A loop or an unreadable link is bad
/// input; a referent whose directory is gone is the same "the place you are
/// saving to no longer exists" condition as the missing-parent check below,
/// so it carries the same code and `detail.dir` that routes the frontend into
/// Save As.
fn link_failure(error: crate::atomic_replace::LinkResolveError) -> CommandError {
    use crate::atomic_replace::LinkResolveError as E;
    match error {
        E::ReferentParentMissing(dir) => parent_missing(&dir),
        E::TooManyLinks => localized_error!(ErrorCode::InvalidInput, "errors.save.symlinkLoop"),
        E::ReadLink(e) => localized_error!(
            ErrorCode::Io,
            "errors.save.writeFailed",
            detail = e.to_string()
        ),
    }
}

/// Localize an atomic-replace failure while keeping the stage and the OS text
/// the `From` impl extracted. The user sees a translated sentence; the frontend
/// still gets `detail.stage` to tell "the temp file could not be created" from
/// "the rename over the target failed".
#[cfg(not(unix))]
fn save_failure(error: crate::atomic_replace::AtomicReplaceError) -> CommandError {
    let converted = CommandError::from(error);
    let localized = localized_error!(
        ErrorCode::Io,
        "errors.save.writeFailed",
        detail = converted.message()
    );
    match converted.detail() {
        Some(detail) => localized.with_detail(detail.clone()),
        None => localized,
    }
}

/// Atomic file write using temp file + rename (async Tauri command variant).
///
/// Prevents data loss on crash by writing to a temporary file in the same
/// directory, flushing to disk, then atomically renaming over the target.
/// Refuses the workspace-grant list, by the path as named AND by the referent
/// the write then lands on (`write_checked`).
#[tauri::command]
pub async fn atomic_write_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    content: String,
) -> Result<(), CommandError> {
    tokio::task::spawn_blocking(move || {
        let target = std::path::Path::new(&path);
        crate::workspace::grants::refuse_list_write(&app, target)?;
        write_checked(target, &content, |at| at.refuse_grant_list(&app))
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

#[cfg(test)]
#[path = "write.test.rs"]
mod tests;
