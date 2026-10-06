//! # Window Manager
//!
//! Purpose: Owns Tauri webview-window creation and lifecycle for document,
//! settings, and transfer windows plus Finder/CLI targeting and delivery.
//!
//! Pipeline: Menu/dock/CLI/Finder actions → functions here → `WebviewWindowBuilder` →
//! new OS window with the React frontend.
//!
//! Module map (one responsibility each, split from the former single file):
//!
//! | Module | Owns |
//! |---|---|
//! | `file_open_state` | Finder/CLI open decisions, pending queue, workspace grouping |
//! | `file_open_store` | That state as per-app managed state, behind one lock |
//! | `finder_open_delivery` | Hot-open focus, targeted emit, and retry fallback |
//! | `document_windows` | Document/main window construction, URLs, labels, dock-reopen pick |
//! | `path_validation` | Security gates for frontend-supplied paths / workspace roots |
//! | `window_url` | The query string a document window opens on (the URL contract with the frontend router) |
//! | `commands` | `open_*_in_new_window`, `close_window` (quitting is `crate::quit`) |
//! | `settings_window` | Settings window singleton (create / focus / navigate) |
//! | `pdf_export_window` | The Export-PDF window, built in Rust so it can carry an empty menu |
//! | `window_creation` | Check-and-build as one step for the fixed labels (`settings`, `main`, `pdf-export`) |
//! | `window_events` | What happens when the OS acts on a window: the close the frontend confirms, the native resources that die with it |
//! | `native_theme` | Keeps OS-drawn chrome (title bar, Windows menu bar) on the in-app theme |
//! | `traffic_lights` | Keeps the macOS window controls where the app places them (macOS only) |
//! | `navigation_guard` | Which URLs an app webview may navigate to (a plugin hook, so `main` is covered) |
//!
//! Everything is re-exported here so call sites keep using
//! `crate::window_manager::...` (and `lib.rs`'s `generate_handler!` paths
//! keep resolving — glob re-exports carry the `#[tauri::command]` macros).
//!
//! **Every command that creates a window is `#[tauri::command(async)]`, and that
//! is load-bearing on Windows (#1301, #1302).** A command without `async` is
//! `ExecutionContext::Blocking`: Tauri runs the body inline on the thread that
//! delivered the IPC message, which on Windows is inside WebView2's
//! `WebMessageReceived` COM callback. Creating a webview from inside a WebView2
//! callback is the reentrancy case WebView2 forbids, so the app hangs — the
//! Settings window paints white and the process needs `taskkill /F`. Both
//! upstreams document it: `WebviewWindowBuilder::new` ("deadlocks when used in a
//! synchronous command"), and tauri-runtime-wry's `create_webview` ("must be
//! called from a separate thread, otherwise the channel will introduce a
//! deadlock").
//!
//! The same window opened from the NATIVE MENU works, because a menu click
//! arrives through tao's event loop rather than a WebView2 callback — which is
//! why #1301 could report the toolbar entry point hanging while the menu entry
//! point did not, and why macOS shows no symptom at all. `pnpm lint:window-thread`
//! (`scripts/check-window-creation-thread.mjs`) holds the property so the next
//! window command cannot be added synchronously.
//!
//! **A window with a fixed label is created through `ensure_window`, never by
//! checking `get_webview_window` and then building.** Off the main thread that
//! pair is a race Tauri does not close — see `window_creation.rs`.
//!
//! Known limitations:
//!   - Window counter is process-global (AtomicU32); labels are not recycled.

// Finder/dock-reopen helpers + the macOS-only settings `window` binding are
// compiled everywhere but only used on macOS; silence the off-macOS lints.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_variables))]

mod commands;
mod document_windows;
mod file_open_state;
mod file_open_store;
mod finder_open_delivery;
mod native_theme;
pub(crate) mod navigation_guard;
mod path_validation;
mod pdf_export_window;
mod settings_window;
#[cfg(target_os = "macos")]
mod traffic_lights;
mod window_creation;
mod window_events;
mod window_url;

pub use commands::*;
pub use document_windows::*;
pub use file_open_state::*;
pub(crate) use file_open_store::*;
// Not macOS-gated: `files::open::route_file_opens` is the shared destination for
// BOTH macOS `RunEvent::Opened` and the Windows/Linux single-instance callback
// (#1330), and this is where it delivers.
pub(crate) use finder_open_delivery::*;
pub use native_theme::*;
pub use pdf_export_window::*;
pub use settings_window::*;
#[cfg(target_os = "macos")]
pub(crate) use traffic_lights::*;
pub(crate) use window_creation::*;
pub(crate) use window_events::*;

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
