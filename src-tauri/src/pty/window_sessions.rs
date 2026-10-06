//! Window-destroy cleanup for PTY sessions.
//!
//! A closing window never runs its React teardown ("the webview dies and the
//! teardown is moot" — `windowCloseFlow.ts`), so the frontend's `pty_close`
//! never arrives. An idle shell produces no output, so its reader never hits
//! the failed channel send that would otherwise kill it: the session and its
//! shell lived on until quit. Each session records the window that spawned it
//! (`Session::owner`), and the window's `Destroyed` event terminates whatever
//! it left behind — the same race, and the same fix, as the window's watcher.
//! They are ended together by `session::terminate`, so one grace period covers
//! all of a window's shells.
//!
//! @coordinates-with app_setup.rs — calls `close_window_sessions` on `Destroyed`
//! @coordinates-with pty/session.rs — `Session`, `PtyState`, `terminate`
//! @module pty/window_sessions

use super::session::{terminate, PtyState, Session};
use std::collections::BTreeMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

/// Remove every session the window `label` spawned and hand them back.
/// Blocking (`blocking_write`) — call only from a non-async context.
fn take_window_sessions(state: &PtyState, label: &str) -> Vec<(u32, Arc<Session>)> {
    let mut sessions = state.sessions.blocking_write();
    let (taken, kept): (BTreeMap<_, _>, BTreeMap<_, _>) = std::mem::take(&mut *sessions)
        .into_iter()
        .partition(|(_, session)| session.owner == label);
    *sessions = kept;
    taken.into_iter().collect()
}

/// Terminate the PTY sessions a destroyed window spawned. Call only from a
/// non-async context (the run-event loop), like `kill_all`.
pub fn close_window_sessions<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(state) = app.try_state::<PtyState>() else {
        return;
    };
    let orphans = take_window_sessions(&state, label);
    if orphans.is_empty() {
        return;
    }
    log::info!(
        "[pty] Window {label:?} destroyed with {} live PTY session(s); terminating",
        orphans.len()
    );
    tauri::async_runtime::spawn_blocking(move || {
        let sessions: Vec<Arc<Session>> = orphans.into_iter().map(|(_, s)| s).collect();
        terminate(&sessions);
    });
}

// Unix-only: the tests spawn `/bin/sleep` and probe pids with `kill(pid, 0)`.
#[cfg(all(test, unix))]
#[path = "window_sessions.test.rs"]
mod tests;
