//! Rust-owned workspace grants (WI-LX1.1).
//!
//! Purpose: decide which folders get a RECURSIVE fs + asset-protocol grant, and
//! remember them across launches. A runtime fs grant is not read-only — the fs
//! plugin accepts a runtime-granted path for every command the capability
//! permits (write, rename, remove) — so this is the widest grant the app makes.
//!
//! Key decisions:
//!   - A root is granted only when Rust can attribute it to the user: the
//!     folder picker Rust shows (`pick_workspace_folder`,
//!     `request_workspace_confirmation`), a folder opened from Finder
//!     (`files/open.rs`), or a root recorded from one of those in an earlier
//!     session. `allow_workspace_access` used to grant ANY path a script handed
//!     it, `/` included; it now only re-issues a recorded root (or a folder
//!     inside one) and refuses the rest.
//!   - A root is recorded only once its grant has TAKEN (`scope.rs`): a choice
//!     the scope did not absorb would be re-issued every launch and open a
//!     workspace that can read nothing.
//!   - The record is `<app data>/workspace-grants.json`, written atomically and
//!     re-granted at launch (`launch.rs`), within a bounded wait.
//!   - A recorded root is re-granted only if it still resolves to ITSELF. Tauri
//!     also inserts the canonical form of a granted path, so re-granting a name
//!     that has since become a link would grant the link's target.
//!   - The list is protected against WEBVIEW-SUPPLIED writes: the fs plugin
//!     is fenced off it (the static scope covers `$HOME/**`, which holds the
//!     app data directory on macOS and Windows), and the file is created at
//!     launch so the fence also catches other spellings of its name;
//!     `atomic_write_file` and `create_file_exclusive` refuse it, and
//!     `run_workflow` refuses a root that contains it (`protect.rs`); and its
//!     array format is one the store plugin, which can write any path but only
//!     a JSON object, cannot produce (`registry.rs`). Not covered: any process
//!     running as the user — the terminal's shell, an AI provider CLI,
//!     anything outside VMark — which can edit it like any other file. An edit
//!     takes effect at the next launch.
//!
//! @coordinates-with workspace/grants/commands.rs — the re-grant command
//! @coordinates-with workspace/grants/picker.rs — the folder pickers
//! @coordinates-with workspace/grants/registry.rs — the list and its file format
//! @coordinates-with workspace/grants/protect.rs — refusing writes to the list
//! @coordinates-with workspace/grants/scope.rs — the recursive grant itself
//! @coordinates-with workspace/grants/launch.rs — re-granting at launch
//! @coordinates-with files/open.rs — Finder folder opens
//! @module workspace/grants

pub mod commands;
mod launch;
pub mod picker;
mod protect;
mod registry;
mod scope;

pub(crate) use launch::restore_at_launch;
// Its test callers run on MockRuntime, which Windows cannot start.
#[cfg(all(test, not(target_os = "windows")))]
pub(crate) use launch::restore_from;
#[cfg(test)]
pub(crate) use protect::names_grant_list;
#[cfg(unix)]
pub(crate) use protect::refuse_held_write;
pub(crate) use protect::{refuse_list_write, refuse_root_containing_list};

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Runtime};

use crate::command_error::{CommandError, ErrorCode};
use registry::{GrantList, MAX_FILE_BYTES};

/// Most access checks that may resolve a path at once.
pub(crate) const MAX_CONCURRENT_CHECKS: usize = 4;

/// File name of the recorded roots, in the app data directory.
pub(crate) const GRANTS_FILE: &str = "workspace-grants.json";

/// The recorded roots and the one-dialog-at-a-time flag. Managed by Tauri.
#[derive(Default)]
pub struct WorkspaceGrants {
    state: Mutex<GrantState>,
    /// Shared with the [`PickerFlight`] that holds it, so a dialog whose answer
    /// is awaited on a spawned task keeps the slot until that task is done.
    picker_open: Arc<AtomicBool>,
    /// Paths an access check is resolving right now ([`WorkspaceGrants::begin_check`]).
    checks: Arc<Mutex<HashSet<PathBuf>>>,
}

/// Held while one access check runs; frees its place when dropped.
pub(crate) struct CheckFlight {
    checks: Arc<Mutex<HashSet<PathBuf>>>,
    path: PathBuf,
}

impl Drop for CheckFlight {
    fn drop(&mut self) {
        let mut checks = self.checks.lock().unwrap_or_else(|p| p.into_inner());
        checks.remove(&self.path);
    }
}

#[derive(Default)]
struct GrantState {
    list: GrantList,
    /// Where the list persists. `None` until launch resolves the app data
    /// directory; a choice made before then is kept in memory and merged.
    file: Option<PathBuf>,
}

/// Held while a folder dialog is open; releases the slot when dropped.
pub(crate) struct PickerFlight(Arc<AtomicBool>);

impl Drop for PickerFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl WorkspaceGrants {
    fn lock(&self) -> std::sync::MutexGuard<'_, GrantState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Is `canonical` a recorded root, or inside one?
    pub(crate) fn covers(&self, canonical: &str) -> bool {
        self.lock().list.covers(canonical)
    }

    /// Record a root the user chose, and persist the list. A failed write is
    /// logged, not returned: the grant already holds for this session, and the
    /// cost of losing the record is one picker confirmation next launch.
    pub(crate) fn record(&self, canonical: &str) {
        let mut state = self.lock();
        if !state.list.record(canonical) {
            return;
        }
        if let Some(file) = state.file.as_deref() {
            if let Err(e) = persist(file, &state.list) {
                log::error!("[workspace-grants] Could not save {:?}: {e}", file);
            }
        }
    }

    fn roots(&self) -> Vec<String> {
        self.lock().list.roots().to_vec()
    }

    /// Where the list persists, once launch has resolved it.
    pub(crate) fn list_file(&self) -> Option<PathBuf> {
        self.lock().file.clone()
    }

    /// Write the list if its file does not exist yet, so the fs-plugin fence
    /// (a case-sensitive glob, matched against the canonical name of an
    /// EXISTING file) covers every spelling of the name from launch on.
    fn persist_if_missing(&self) {
        let state = self.lock();
        let Some(file) = state.file.as_deref() else {
            return;
        };
        if file.exists() {
            return;
        }
        if let Err(e) = persist(file, &state.list) {
            log::error!("[workspace-grants] Could not create {:?}: {e}", file);
        }
    }

    /// Adopt `file` as the list's home, folding what it holds in behind any
    /// root chosen earlier this session. An unreadable file contributes
    /// nothing and is replaced by the next choice.
    ///
    /// A root chosen before the load (a Finder open can precede setup) changes
    /// the merged list, and nothing else would write it while the file exists
    /// — `record` persisted nothing without a file, and `persist_if_missing`
    /// skips an existing one — so the merge is written here.
    fn load(&self, file: PathBuf) {
        let from_disk = read_list(&file);
        let mut state = self.lock();
        state.list.absorb(from_disk.clone());
        if state.list != from_disk {
            if let Err(e) = persist(&file, &state.list) {
                log::error!("[workspace-grants] Could not save {:?}: {e}", file);
            }
        }
        state.file = Some(file);
    }

    /// Claim a place to check `path`: refused with `conflict` while that path
    /// is already being checked or [`MAX_CONCURRENT_CHECKS`] checks are
    /// running. A check can hold a blocking thread for a dead mount's timeout,
    /// so this is what keeps a repeated call from draining the pool.
    pub(crate) fn begin_check(
        &self,
        path: impl Into<PathBuf>,
    ) -> Result<CheckFlight, CommandError> {
        let path = path.into();
        let mut checks = self.checks.lock().unwrap_or_else(|p| p.into_inner());
        if checks.len() >= MAX_CONCURRENT_CHECKS || !checks.insert(path.clone()) {
            return Err(crate::localized_error!(
                ErrorCode::Conflict,
                "errors.workspaceAccess.checkBusy"
            ));
        }
        Ok(CheckFlight {
            checks: Arc::clone(&self.checks),
            path,
        })
    }

    /// Claim the folder-dialog slot, or `None` while another dialog is open.
    pub(crate) fn begin_picker(&self) -> Option<PickerFlight> {
        self.picker_open
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| PickerFlight(Arc::clone(&self.picker_open)))
    }
}

/// The list in `file`, or an empty one when there is none this build can read.
/// At most [`MAX_FILE_BYTES`] + 1 bytes are read, so an oversized file costs
/// no more memory than the limit before `parse` refuses it.
fn read_list(file: &Path) -> GrantList {
    let mut bytes = Vec::new();
    let read = std::fs::File::open(file)
        .and_then(|f| f.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes));
    match read {
        Ok(_) => GrantList::parse(&bytes).unwrap_or_else(|e| {
            log::warn!("[workspace-grants] Ignoring {:?}: {e}", file);
            GrantList::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GrantList::default(),
        Err(e) => {
            log::warn!("[workspace-grants] Could not read {:?}: {e}", file);
            GrantList::default()
        }
    }
}

fn persist(file: &Path, list: &GrantList) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::app_paths::atomic_write_file(file, &list.to_bytes())
}

/// Resolve `raw` to the canonical folder it names, spelled for the frontend.
pub(crate) fn canonical_dir(raw: &Path) -> Result<String, CommandError> {
    if !raw.is_absolute() {
        return Err(CommandError::invalid_input(format!(
            "'{}' is not absolute",
            raw.display()
        )));
    }
    let canonical = raw.canonicalize().map_err(|e| {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            _ => ErrorCode::Io,
        };
        CommandError::new(
            code,
            format!("'{}' could not be resolved: {e}", raw.display()),
        )
    })?;
    if !canonical.is_dir() {
        return Err(CommandError::invalid_input(format!(
            "'{}' is not a folder",
            raw.display()
        )));
    }
    crate::canonical_path::canonical_string(&canonical, "workspace folder")
        .map_err(CommandError::invalid_input)
}

/// Grant `raw` because the USER chose it — the folder picker, or Finder — and
/// record it so later launches re-grant it. Returns the canonical root. A
/// grant that did not take is an error, and nothing is recorded.
pub(crate) fn grant_chosen_root<R: Runtime>(
    app: &AppHandle<R>,
    raw: &Path,
) -> Result<String, CommandError> {
    let root = canonical_dir(raw)?;
    scope::grant_workspace_scope(app, &root)?;
    app.state::<WorkspaceGrants>().record(&root);
    Ok(root)
}

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
