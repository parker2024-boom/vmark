//! Settings window singleton: create, re-focus, and section navigation.
//!
//! Key decision: the settings window is a singleton — re-shown and focused
//! if already open, with `settings:navigate` emitted for section jumps.
//!
//! Key decision: "is it open? if not, build it" is ONE step, taken through
//! `ensure_window` (`window_creation.rs`). Once `open_settings_window` became
//! `#[tauri::command(async)]` (see `mod.rs` — the Windows deadlock), two rapid
//! clicks stopped being serialized by the IPC loop, and a check here followed
//! by a build there let both clicks see "no settings window" and both build
//! one: Tauri checks the label on the calling thread and registers it
//! unconditionally afterwards, so the second window silently replaced the
//! first under the same label. A caller that arrives second now focuses the
//! window the first one built.

use tauri::{AppHandle, Emitter, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{ensure_window, Ensured};

const SETTINGS_WIDTH: f64 = 760.0;
// 540 cut most panels off mid-list, so the window opened already scrolled.
const SETTINGS_HEIGHT: f64 = 680.0;
const SETTINGS_MIN_WIDTH: f64 = 600.0;
const SETTINGS_MIN_HEIGHT: f64 = 400.0;

/// Create or focus the settings window.
/// If settings window exists, focuses it. Otherwise creates a new one.
/// Returns the window label on success.
pub fn show_settings_window(app: &AppHandle) -> Result<String, tauri::Error> {
    show_settings_window_section(app, None)
}

/// Tauri command wrapper for frontend Settings entry points.
/// `(async)` is required: a sync command creates the window on the main thread,
/// which deadlocks WebView2 on Windows (#1301). See `window_manager/mod.rs`.
#[tauri::command(async)]
pub fn open_settings_window(app: AppHandle, section: Option<String>) -> Result<String, String> {
    show_settings_window_section(&app, section.as_deref().filter(|s| !s.is_empty()))
        .map_err(|e| e.to_string())
}

/// Build the Settings window URL for an optional section.
///
/// The section is percent-encoded so a value containing reserved characters
/// (`&`, `?`, `#`) cannot corrupt the query or append a fragment.
fn settings_url(section: Option<&str>) -> String {
    match section {
        Some(s) => format!("/settings?section={}", urlencoding::encode(s)),
        None => "/settings".to_string(),
    }
}

/// The singleton's window label.
pub(super) const SETTINGS_LABEL: &str = "settings";

/// Reveal the already-open Settings window and jump to `section`.
fn reveal_and_navigate<R: Runtime>(window: &WebviewWindow<R>, section: Option<&str>) {
    // Unminimize if minimized
    if window.is_minimized().unwrap_or(false) {
        log::debug!("[window_manager] Settings was minimized, unminimizing");
        let _ = window.unminimize();
    }
    // Show and focus
    let _ = window.show();
    let _ = window.set_focus();
    // Navigate to section if specified
    if let Some(s) = section {
        let _ = window.emit("settings:navigate", s);
    }
}

/// Build the Settings window on `url`. Runs on the main thread, inside
/// `ensure_window`, only when no Settings window exists.
fn build_settings_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: String,
) -> tauri::Result<WebviewWindow<R>> {
    // On Linux/GTK, creating the window hidden and then changing size/position
    // before show can leave the native titlebar hit-test region stale until the
    // first maximize/unmaximize cycle. Create non-macOS settings windows with
    // their final geometry up front so close/minimize/maximize respond
    // immediately.
    let settings_title = rust_i18n::t!("window.settings.title").to_string();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(&settings_title)
        .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
        .min_inner_size(SETTINGS_MIN_WIDTH, SETTINGS_MIN_HEIGHT)
        .resizable(true)
        // Match the OS-drawn title bar to the in-app theme from the first
        // frame. Setting it after build would flash a light title bar on a
        // dark theme; on macOS this is a no-op (overlay title bar).
        .theme(Some(super::current_theme()))
        .focused(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // A runtime-built window does not inherit tauri.conf.json's window
            // entry, so the buttons have to be placed here too — see
            // super::TRAFFIC_LIGHT_POSITION.
            .traffic_light_position(super::TRAFFIC_LIGHT_POSITION)
            .visible(false);
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder
            .menu(tauri::menu::Menu::new(app)?)
            .center()
            .visible(true);
    }

    let window = builder.build()?;

    #[cfg(target_os = "macos")]
    {
        // Override any restored state by explicitly setting size and centering.
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: SETTINGS_WIDTH,
            height: SETTINGS_HEIGHT,
        }));
        let _ = window.center();
        let _ = window.show();
    }

    Ok(window)
}

/// Create or focus the settings window, optionally navigating to a specific section.
/// If settings window exists, focuses it and navigates to the section.
/// Otherwise creates a new one with the section in the URL.
///
/// Generic over the runtime so a mock app can exercise the concurrent-create
/// path (`settings_window.test.rs`); the `#[tauri::command]` wrapper above is
/// unaffected and still resolves to `Wry`.
pub fn show_settings_window_section<R: Runtime>(
    app: &AppHandle<R>,
    section: Option<&str>,
) -> Result<String, tauri::Error> {
    let url = settings_url(section);
    let ensured = ensure_window(app, SETTINGS_LABEL, move |app, label| {
        log::debug!("[window_manager] Creating new settings window");
        build_settings_window(app, label, url)
    })?;

    match ensured {
        // Built on the requested section: there is nothing to navigate.
        Ensured::Created(_) => {}
        Ensured::Existing(window) => {
            log::debug!("[window_manager] Settings window exists, focusing it");
            reveal_and_navigate(&window, section);
        }
        // Another call is building it and it will open focused. The window the
        // user asked for is on its way, so this is success, not an error.
        Ensured::Pending => {
            log::debug!("[window_manager] Settings is being created by another call");
        }
    }

    Ok(SETTINGS_LABEL.to_string())
}

#[cfg(test)]
#[path = "settings_window.test.rs"]
mod tests;
