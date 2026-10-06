//! Creating a window under a FIXED label, at most once.
//!
//! Purpose: `settings`, `main` and `pdf-export` are singletons addressed by
//! label, so "does it exist? if not, build it" has to be one step for them.
//! Tauri does not make it one. `WebviewWindowBuilder::build` checks the label
//! on the CALLING thread, hands the native creation to the event loop, and
//! then registers the label unconditionally. Two callers on two threads can
//! both pass the check, both get a native window, and the second registration
//! replaces the first: two windows on screen under one label, one of them
//! unreachable, its IPC routed to the other.
//!
//! Key decisions:
//!   - The check and the build run together as ONE task on the main thread
//!     ([`ensure_window`]). The event loop runs one task at a time, so no
//!     other creation can run between them, and a caller that arrives second
//!     finds the window the first one registered.
//!   - This does not move the native creation, so it is as safe on Windows as
//!     what it replaces (#1301). The WebView2 hazard is creating a webview
//!     from inside a WebView2 callback, which is where a synchronous command
//!     body runs. A task posted from a worker runs from the event loop
//!     instead — where the runtime already ran a worker's create request, and
//!     where a native-menu click has always built the Settings window. The
//!     window-creating commands stay `async` (`pnpm lint:window-thread`), so
//!     the task is always posted from a worker, never run inline in a
//!     callback.
//!   - No lock is held across the build. A mutex around check-then-create is
//!     the obvious alternative and the wrong one: building blocks on the main
//!     thread (off macOS, `Menu::new` does), so a worker holding the lock
//!     while the main thread waits for it — the menu's own Preferences
//!     handler — is a deadlock.
//!   - A label that is mid-build is CLAIMED, and a caller that finds the claim
//!     taken gets [`Ensured::Pending`] instead of waiting. With every build on
//!     the main thread the claim is never contended; it is what keeps "one
//!     window per label" true if a build is ever re-entered (a nested message
//!     pump) or run off the event loop, and it is the part a mock runtime —
//!     which runs main-thread tasks inline on the caller — can exercise.
//!
//! @coordinates-with settings_window.rs, document_windows.rs, pdf_export_window.rs — the fixed labels
//! @module window_manager/window_creation

use std::collections::HashSet;
use std::sync::{mpsc, Mutex};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// What [`ensure_window`] found or did.
pub(crate) enum Ensured<R: Runtime> {
    /// This call built the window.
    Created(WebviewWindow<R>),
    /// The label already named a live window; nothing was built.
    Existing(WebviewWindow<R>),
    /// Another call is building this label right now; nothing was built, and
    /// there is no window to hand back yet.
    Pending,
}

/// The fixed labels being built right now, per app.
///
/// Managed state rather than a `static`: every mock app in the test binary
/// uses the same labels, and one app's build must not look like another's.
#[derive(Default)]
struct LabelsBeingBuilt(Mutex<HashSet<String>>);

impl LabelsBeingBuilt {
    fn labels(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Claim `label` until the returned guard drops; `None` if it is claimed.
    fn claim<'a>(&'a self, label: &'a str) -> Option<LabelClaim<'a>> {
        // A `LabelClaim` exists only for a claim that was taken: dropping one
        // releases the label, so building it for the losing caller would hand
        // the winner's claim back while its window is still half built.
        let newly_claimed = self.labels().insert(label.to_owned());
        newly_claimed.then(|| LabelClaim { held: self, label })
    }
}

/// Releases its label on drop, so a build that fails or panics frees it.
struct LabelClaim<'a> {
    held: &'a LabelsBeingBuilt,
    label: &'a str,
}

impl Drop for LabelClaim<'_> {
    fn drop(&mut self) {
        self.held.labels().remove(self.label);
    }
}

/// Return the window under `label`, building it with `build` if there is none.
///
/// `build` is handed the app and the label and runs on the main thread, at
/// most once, and only when the label names no window. The caller is blocked
/// until it has run, exactly as it was blocked on `build()` before.
///
/// Do not call this while holding a lock the main thread may take.
pub(crate) fn ensure_window<R, B>(
    app: &AppHandle<R>,
    label: &str,
    build: B,
) -> tauri::Result<Ensured<R>>
where
    R: Runtime,
    B: FnOnce(&AppHandle<R>, &str) -> tauri::Result<WebviewWindow<R>> + Send + 'static,
{
    let (reply, outcome) = mpsc::sync_channel(1);
    let on_main = app.clone();
    let label = label.to_owned();
    app.run_on_main_thread(move || {
        // The receiver is gone only if the caller's thread died waiting.
        let _ = reply.send(check_and_build(&on_main, &label, build));
    })?;
    // The task was dropped unrun: the event loop is shutting down.
    outcome
        .recv()
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?
}

fn check_and_build<R, B>(app: &AppHandle<R>, label: &str, build: B) -> tauri::Result<Ensured<R>>
where
    R: Runtime,
    B: FnOnce(&AppHandle<R>, &str) -> tauri::Result<WebviewWindow<R>>,
{
    // `manage` keeps the first value it is given, so every caller shares one set.
    app.manage(LabelsBeingBuilt::default());
    let being_built = app.state::<LabelsBeingBuilt>();
    let Some(_claim) = being_built.claim(label) else {
        return Ok(Ensured::Pending);
    };
    if let Some(existing) = app.get_webview_window(label) {
        return Ok(Ensured::Existing(existing));
    }
    build(app, label).map(Ensured::Created)
}

#[cfg(test)]
#[path = "window_creation.test.rs"]
mod tests;
