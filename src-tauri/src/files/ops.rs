//! # File Ops
//!
//! Purpose: Lightweight per-file commands. `get_file_size_bytes` is the
//! size-check step of the large-file open flow; `move_paths_to_trash` moves
//! orphaned files to the system trash instead of unlinking them.
//!
//! Pipeline: Frontend invoke("get_file_size_bytes") → fs::metadata → len in bytes.
//!
//! Key decisions:
//!   - Symbolic links are followed (`fs::metadata` default) so the reported size
//!     matches what a subsequent `readTextFile` will actually load.
//!   - Failures reject with a typed `CommandError` whose code is the class the
//!     OS reported (`not-found`, `permission-denied`, `io`), and a path that is
//!     not a regular file is `invalid-input`. The large-file router treats any
//!     rejection as "size unknown" and lets the read that follows report it.
//!   - Returns `u64` directly; JS/TS handles values up to `Number.MAX_SAFE_INTEGER`
//!     (~9 PB), far above the 50 MB liability floor.

use std::fs;
use std::path::Path;

use crate::command_error::CommandError;

/// Reject paths that cannot resolve to a regular file on disk. Keeps the
/// webview from probing non-file entries (directories, devices, character
/// specials) and, via `canonicalize`, from relying on traversal tricks to
/// reach outside the allowed filesystem scope. We deliberately do NOT
/// restrict by extension here — the open dialog allows `.md`, `.markdown`,
/// `.mdown`, `.mkd`, and `.txt`, and constraining extension at the backend
/// broke non-markdown opens during the audit pass.
fn validate_openable_path(raw: &str) -> Result<(), CommandError> {
    let canonical = Path::new(raw)
        .canonicalize()
        .map_err(|e| CommandError::from_io(&e, format!("invalid path '{raw}': {e}")))?;
    if !canonical.is_file() {
        return Err(CommandError::invalid_input(format!(
            "path '{raw}' is not a regular file"
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_file_size_bytes(path: String) -> Result<u64, CommandError> {
    validate_openable_path(&path)?;
    let metadata = fs::metadata(&path)
        .map_err(|e| CommandError::from_io(&e, format!("Failed to stat {path}: {e}")))?;
    Ok(metadata.len())
}

/// Outcome of a batch trash operation — partial failure is normal
/// (permissions, network volumes without a trash, files already gone).
#[derive(serde::Serialize)]
pub struct TrashOutcome {
    /// Paths successfully moved to the system trash.
    pub trashed: Vec<String>,
    /// Paths that could not be trashed, with the reason.
    pub failed: Vec<TrashFailure>,
}

#[derive(serde::Serialize)]
pub struct TrashFailure {
    pub path: String,
    pub error: String,
}

/// Move files to the SYSTEM TRASH instead of unlinking them.
///
/// Orphan-image cleanup deletes user files on inference — a scan concluding
/// "nothing references this". Every wrong conclusion used to be irreversible;
/// via the trash it is an undo. Callers treat a failure as "file kept", never
/// fall back to permanent deletion themselves: a volume without a trash keeps
/// its files, which is the fail-safe direction.
///
/// Paths are canonicalized and must be regular files — the same probe-guard
/// as the other file commands; cleanup has no business trashing directories.
#[tauri::command]
pub async fn move_paths_to_trash(paths: Vec<String>) -> Result<TrashOutcome, CommandError> {
    tokio::task::spawn_blocking(move || {
        let mut trashed = Vec::new();
        let mut failed = Vec::new();
        for raw in paths {
            // A per-path reason travels as text inside the outcome; only a
            // failure of the whole batch is a command rejection.
            match validate_openable_path(&raw)
                .map_err(|e| e.message().to_owned())
                .and_then(|()| trash::delete(&raw).map_err(|e| format!("trash failed: {e}")))
            {
                Ok(()) => trashed.push(raw),
                Err(error) => failed.push(TrashFailure { path: raw, error }),
            }
        }
        TrashOutcome { trashed, failed }
    })
    .await
    .map_err(|e| CommandError::internal(format!("Trash task failed: {e}")))
}

#[cfg(test)]
#[path = "ops.test.rs"]
mod tests;
