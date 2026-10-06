//! Running a coherence command's kernel work off the async runtime.
//!
//! Purpose: every coherence command is `async`, so Tauri runs it on a tokio
//! worker. The work itself is not async at all — opening a kernel
//! canonicalizes the root and may rebuild the index from the ledger, and the
//! kernel's reads and writes are SQLite, file reads, fsyncs and hashing. Done
//! inline, that blocks the worker for as long as the disk takes, and every
//! other IPC call scheduled on it waits. The work runs on the blocking pool
//! instead.
//!
//! Key decisions:
//!   - The kernel `Mutex` guard is taken and dropped INSIDE the blocking task,
//!     so no `std::sync` guard can be alive across an `.await`.
//!   - The managed `CoherenceState` is looked up inside the task from an
//!     owned `AppHandle`, because a `State<'_, _>` borrowed from the IPC call
//!     cannot be moved into a `'static` task. A missing state is an error, not
//!     a panic.
//!
//! @coordinates-with commands_ipc.rs — and every other coherence command wrapper
//! @coordinates-with state.rs — `KernelRegistry::kernel_for`
//! @module coherence/blocking

use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};

use super::command_errors::{kernel_poisoned, workspace_unavailable};
use super::commands::CoherenceState;
use super::state::WorkspaceKernel;
use crate::command_error::CommandError;

/// Run `work` on the blocking pool and hand back its result.
pub(crate) async fn on_blocking_pool<T, F>(work: F) -> Result<T, CommandError>
where
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| CommandError::internal(format!("coherence task failed: {e}")))?
}

/// Open (or reuse) the kernel for `workspace_root`, lock it, and run `work`
/// against it — all on the blocking pool.
pub(crate) async fn with_kernel<R, T, F>(
    app: AppHandle<R>,
    workspace_root: String,
    work: F,
) -> Result<T, CommandError>
where
    R: Runtime,
    F: FnOnce(&CoherenceState, &mut WorkspaceKernel) -> Result<T, CommandError> + Send + 'static,
    T: Send + 'static,
{
    on_blocking_pool(move || {
        let state = app
            .try_state::<CoherenceState>()
            .ok_or_else(|| CommandError::internal("coherence state is not available"))?;
        let kernel = state
            .registry
            .kernel_for(Path::new(&workspace_root), state.writer)
            .map_err(workspace_unavailable)?;
        let mut kernel = kernel.lock().map_err(|_| kernel_poisoned())?;
        work(&state, &mut kernel)
    })
    .await
}

#[cfg(test)]
#[path = "blocking.test.rs"]
mod tests;
