//! Delivery of a system file-open to one document window.
//!
//! Rust broadcasts the event because the frontend listens through Tauri's
//! global event API. The payload carries the selected window label so every
//! other document window can reject the broadcast.
//!
//! Reached from macOS `RunEvent::Opened` and from the Windows/Linux
//! single-instance callback, both via `files::open::route_file_opens` — so this
//! module is NOT macOS-only, whatever the `[Finder]` log prefixes suggest.

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::PendingFileOpen;

use super::{ensure_main_window, file_open_state, Ensured, QueueOwner};

#[derive(Clone, Serialize)]
struct TargetedFileOpen {
    path: String,
    workspace_root: Option<String>,
    target_window_label: String,
}

fn live_target_excluding<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    excluded: Option<&str>,
) -> Option<String> {
    let live_labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| excluded != Some(label.as_str()))
        .cloned()
        .collect();
    file_open_state(app)
        .lock()
        .finder_window_target(&live_labels)
}

fn live_target<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    live_target_excluding(app, None)
}

fn queue_for_new_main<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    payloads: Vec<PendingFileOpen>,
) {
    {
        let store = file_open_state(app);
        let mut state = store.lock();
        state.owner = QueueOwner::Booting;
        state.pending.extend(payloads);
    }
    bring_up_queue_owner(app);
}

/// Make sure a `main` window exists to drain the cold-start queue: the one
/// that is already up or being built, or a new one. The caller has queued its
/// opens and marked the owner booting.
///
/// Check-and-build is one step (`ensure_main_window`), so two opens arriving
/// together cannot each build a `main`.
pub(crate) fn bring_up_queue_owner<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    match ensure_main_window(app, None) {
        Ok(Ensured::Created(_)) => {
            log::info!("[FileOpen] Created the main window for queued opens");
        }
        Ok(Ensured::Existing(_) | Ensured::Pending) => {
            log::info!("[FileOpen] Queued opens wait for the main window");
        }
        Err(error) => {
            log::error!("[FileOpen] Failed to create main window for queued opens: {error}");
            // No window is booting after all. The queue is kept; settling the
            // owner lets the next open try again instead of waiting forever.
            file_open_state(app).lock().owner = QueueOwner::Settled;
        }
    }
}

/// Bring `window` to the front, whatever state it is in.
///
/// The ONE copy of the reveal sequence. `single_instance::surface_a_window`
/// carried a second one — same three calls, same order, and its own three log
/// lines — so a fix to either was a divergence from the other, on the two
/// paths a user reaches by the same gesture: double-clicking a file, and
/// double-clicking the app while it is already running.
///
/// `set_focus` is Tauri's native bring-to-front operation, and it is LAST:
/// showing and unminimizing first is what covers a hidden or minimized
/// window, which is otherwise focused where nobody can see it. Each step
/// reports its own failure and the next one still runs — a window that
/// refuses `show` may still accept `set_focus`, and giving up on the first
/// refusal would surface nothing at all. The label is printed with `{:?}` so
/// it cannot forge a log line.
pub(crate) fn reveal_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, label: &str) {
    if let Err(error) = window.show() {
        log::warn!("[Window] show({label:?}) failed: {error}");
    }
    if let Err(error) = window.unminimize() {
        log::warn!("[Window] unminimize({label:?}) failed: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("[Window] set_focus({label:?}) failed: {error}");
    }
}

fn focus_and_emit<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    target_label: &str,
    payloads: Vec<PendingFileOpen>,
) -> Vec<PendingFileOpen> {
    let Some(window) = app.get_webview_window(target_label) else {
        return payloads;
    };

    reveal_window(&window, target_label);

    log::info!("[Finder] Emitting to window {:?}", target_label);
    let mut failed = Vec::new();
    for payload in payloads {
        let event = TargetedFileOpen {
            path: payload.path.clone(),
            workspace_root: payload.workspace_root.clone(),
            target_window_label: target_label.to_string(),
        };
        if let Err(error) = app.emit("app:open-file", event) {
            log::warn!("[Finder] emit failed, queueing: {error}");
            failed.push(payload);
        }
    }
    failed
}

/// Retry once against a freshly selected fallback if the chosen window
/// vanished between selection and native delivery.
fn focus_and_emit_with_fallback<R, F>(
    app: &tauri::AppHandle<R>,
    target_label: &str,
    payloads: Vec<PendingFileOpen>,
    fallback_target: F,
) -> Vec<PendingFileOpen>
where
    R: tauri::Runtime,
    F: FnOnce() -> Option<String>,
{
    let failed = focus_and_emit(app, target_label, payloads);
    if failed.is_empty() {
        return failed;
    }

    let Some(fallback_label) = fallback_target() else {
        return failed;
    };
    if fallback_label == target_label {
        return failed;
    }

    log::info!(
        "[Finder] retrying delivery after {:?} vanished using {:?}",
        target_label,
        fallback_label
    );
    focus_and_emit(app, &fallback_label, failed)
}

/// Reveal the selected native window and broadcast target-tagged open events.
/// Re-check the ready-window set at delivery time. If no listener-ready
/// document window remains, return the payloads to the cold-start queue.
pub(crate) fn emit_finder_opens_to_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    payloads: Vec<PendingFileOpen>,
) {
    let Some(target_label) = live_target(app) else {
        log::info!("[Finder] no ready target window before emit — re-queueing");
        queue_for_new_main(app, payloads);
        return;
    };
    let failed = focus_and_emit_with_fallback(app, &target_label, payloads, || {
        live_target_excluding(app, Some(&target_label))
    });

    if !failed.is_empty() {
        log::info!("[Finder] target vanished or emit failed — re-queueing");
        queue_for_new_main(app, failed);
    }
}

#[cfg(test)]
#[path = "finder_open_delivery.test.rs"]
mod tests;
