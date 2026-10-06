//! The restore's filesystem half (split from `snapshot_restore.rs` at the
//! file-size gate): put one file back, and delete one file a run created —
//! both inside a workspace root HELD OPEN for the whole restore.
//!
//! Two windows this closes, both found by audit:
//!   - **The root itself.** The anchored helpers used to take the root as
//!     a PATH and open it again for every file, so a root swapped for a link
//!     partway through a restore became "the workspace" for every file after
//!     it — and each target, resolved through the same link, passed the
//!     containment walk. [`HeldRoot`] opens it once; every walk compares
//!     against that directory.
//!   - **The delete.** It checked a canonical parent and then called a
//!     path-based `remove_file`, which resolves the name again: a parent
//!     swapped for an escaping link in between deleted a file outside. The
//!     parent is now opened once, proved inside the held root, and the entry
//!     is examined (without following a link) and unlinked through that same
//!     descriptor.
//!
//! What stays open: the recorded root is resolved by NAME once, when the
//! restore starts — there is no trusted identity to check that first
//! resolution against, the same position `action/save-file` is in. That one
//! resolution is also the only one: the canonical path is then opened with no
//! link followed at any component, so a swap between resolving
//! and opening is refused rather than followed. Off Unix
//! there are no `*at` calls and both operations stay path-based; the fallback
//! states its residual below, as `commit.rs` and `ensure_dir.rs` do.
//!
//! @coordinates-with snapshot_restore.rs — the only caller
//! @coordinates-with commit_dir.rs, ensure_dir.rs — `commit_in`, `create_parents_in`
//! @coordinates-with dir_fd.rs — the descriptor type and the `..` walk
//! @module workflow::snapshot_write

use std::path::{Path, PathBuf};

/// The recorded workspace root, held for the whole restore: an open directory
/// on Unix, so containment is judged against ONE directory whatever the name
/// resolves to later.
pub(super) struct HeldRoot {
    path: PathBuf,
    #[cfg(unix)]
    dir: super::dir_fd::Dir,
}

impl HeldRoot {
    /// Hold `path`, which the caller has already canonicalized. Opened
    /// without following a link at any component: a root or ancestor
    /// swapped for a link after the canonicalization is refused, so the
    /// directory held is the one that was resolved.
    pub(super) fn open(path: PathBuf) -> Result<Self, String> {
        #[cfg(unix)]
        let dir = super::dir_fd::Dir::open_nofollow(&path)?;
        Ok(Self {
            path,
            #[cfg(unix)]
            dir,
        })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

/// Put `bytes` at `target`, creating its missing parents, inside the held
/// root — the same anchored commit `action/save-file` uses.
pub(super) fn write_back(target: &Path, root: &HeldRoot, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;
    #[cfg(unix)]
    {
        super::ensure_dir::create_parents_in(parent, &root.dir, || {})?;
        super::commit_dir::commit_in(target, &root.dir, bytes, || {})
    }
    #[cfg(not(unix))]
    {
        super::ensure_dir::create_parents_within(parent, root.path())?;
        super::commit::commit_inside_workspace(target, root.path(), bytes)
    }
}

/// Delete a file the run created. `Ok(false)` when it is already gone. A name
/// that is now a link or a directory is NOT the file the run made, and
/// following a link would delete its target — so it is refused.
pub(super) fn delete_created(target: &Path, root: &HeldRoot) -> Result<bool, String> {
    delete_created_with(target, root, || {})
}

/// [`delete_created`] with a seam: `between` runs after the parent is proved
/// inside the root and before the entry is examined and removed — the window
/// an attacker would need. It exists so the race is testable; production
/// passes `|| {}`.
#[cfg(unix)]
pub(super) fn delete_created_with(
    target: &Path,
    root: &HeldRoot,
    between: impl FnOnce(),
) -> Result<bool, String> {
    use super::dir_fd::{c_name, Dir};
    let parent = target
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;
    let name = c_name(
        target
            .file_name()
            .ok_or_else(|| "no file name".to_string())?,
    )?;
    let dir = match Dir::open(parent) {
        Ok(dir) => dir,
        // A parent that is gone holds no file; anything else is a real failure.
        Err(_) if matches!(parent.try_exists(), Ok(false)) => return Ok(false),
        Err(e) => return Err(e),
    };
    dir.assert_within(&root.dir, parent)?;
    between();
    match dir.is_regular_file(&name)? {
        None => Ok(false),
        Some(false) => Err("no longer a regular file".to_string()),
        // `unlinkat` never follows the final component, so a regular file
        // swapped for a link after the probe removes the link, not its target.
        Some(true) => dir.unlink(&name).map(|()| true),
    }
}

/// Windows has no `unlinkat`, and is a best-effort platform here.
///
/// **The residual, stated.** This is check-then-remove by path: a
/// parent replaced with a junction between the canonical check and
/// `remove_file` is followed. It is the same residual, for the same reason,
/// as `commit.rs`'s and `ensure_dir.rs`'s fallbacks — the primitive that would
/// close it is `NtCreateFile` relative to a directory HANDLE, out of reach in
/// this crate's dependency set and untestable on a leg that only
/// cross-compiles.
#[cfg(not(unix))]
pub(super) fn delete_created_with(
    target: &Path,
    root: &HeldRoot,
    between: impl FnOnce(),
) -> Result<bool, String> {
    let meta = match std::fs::symlink_metadata(target) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.file_type().is_file() {
        return Err("no longer a regular file".to_string());
    }
    let parent = target
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or_else(|| "parent directory unresolvable".to_string())?;
    if !parent.starts_with(root.path()) {
        return Err("parent resolves outside the workspace".to_string());
    }
    between();
    std::fs::remove_file(target)
        .map(|()| true)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "snapshot_write.test.rs"]
mod tests;
