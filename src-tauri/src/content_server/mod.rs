//! Content-server integration (Phase 1).
//!
//! Owns runtime resolution and the workspace-keyed lifecycle of spawned
//! content-server processes (`ContentServerManager`, in `manager`).
//!
//! Live wiring: `commands` + `slidev_commands` (registered in `lib.rs`) drive
//! the lifecycle; `spawn` spawns the Node runtime with piped stdio → `log`;
//! `drain` turns its pipes into log lines;
//! `supervisor` watches it (`monitor_child` → `content-server:exited`);
//! every teardown goes through `cleanup`, and a child it
//! could not stop or reap stays owned by the manager; `http` +
//! `slidev_commands` talk to the running server through the one
//! authenticated loopback client in `client`.
//! `runtime` probes what a start would find without starting anything
//! (`content_server_runtime` + the one startup log line — settled at
//! quit so a missing line is explained), and
//! `bundle_manifest` holds the single constant that joins `spawn::resolve_cli`
//! to `tauri.conf.json`'s `bundle.resources` — `None` today, because
//! no release build ships the content server.

pub mod bundle_manifest;
pub mod cleanup;
mod client;
pub mod commands;
mod drain;
pub mod http;
pub mod manager;
mod port_wait;
pub mod runtime;
pub mod slidev_commands;
pub mod spawn;
mod start;
mod supervisor;

pub use manager::{ChildState, ContentServerManager};

/// Kill all managed content-server children and remove their port files,
/// after settling the startup probe so the log explains a missing
/// runtime line before it goes quiet.
///
/// Must be called explicitly on the quit path (`quit::finalize_quit` and the
/// `ExitRequested` → `AllowExit` branch): `app.exit` terminates the process
/// via `std::process::exit`, which never drops Tauri-managed state, so the
/// manager's `Drop` cannot be relied on at quit. Idempotent.
pub fn cleanup(app: &tauri::AppHandle) {
    use tauri::Manager;
    runtime::settle_probe(app);
    if let Some(mgr) = app.try_state::<ContentServerManager>() {
        mgr.shutdown_all();
    }
}
