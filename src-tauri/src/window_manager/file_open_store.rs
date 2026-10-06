//! The app's Finder/CLI file-open state, as Tauri-managed state.
//!
//! Purpose: hold the one [`FileOpenState`] every open is decided against, and
//! hand it to whoever has an app handle.
//!
//! Key decisions:
//!   - Managed state, not a `static`. Every reader already holds an
//!     `AppHandle`, and a process-wide static made the state of one mock app
//!     visible to every other test's app.
//!   - Registered on first use rather than in `setup`: a Finder open can be
//!     routed before setup has run, and a mock app runs no setup at all.
//!   - The lock recovers from poison here, once, so no caller can forget to.
//!
//! @coordinates-with file_open_state.rs — the state and its decisions
//! @module window_manager/file_open_store

use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Manager, Runtime};

use super::FileOpenState;

/// The lock around this app's [`FileOpenState`].
#[derive(Default)]
pub(crate) struct FileOpenStore(Mutex<FileOpenState>);

impl FileOpenStore {
    /// Lock the state. A holder that panicked leaves the data as it was, and
    /// dropping file opens for the rest of the session would be worse than
    /// reading it.
    pub(crate) fn lock(&self) -> MutexGuard<'_, FileOpenState> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Queue the files a cold launch was handed on its command line.
    #[cfg(any(not(target_os = "macos"), test))]
    pub(crate) fn queue_launch_file_args(&self, file_args: Vec<String>) {
        super::queue_launch_file_args(&self.0, file_args);
    }
}

/// This app's file-open state.
pub(crate) fn file_open_state<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, FileOpenStore> {
    if let Some(store) = app.try_state() {
        return store;
    }
    // `manage` keeps the first value it is given, so two first uses racing
    // here end up sharing one store.
    app.manage(FileOpenStore::default());
    app.state()
}

#[cfg(test)]
#[path = "file_open_store.test.rs"]
mod tests;
