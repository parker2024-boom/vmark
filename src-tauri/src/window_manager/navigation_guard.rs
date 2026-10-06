//! Which URLs an app webview may navigate to.
//!
//! Purpose: a webview that hosts the app's own UI must only ever show the
//! app's own pages. Without a rule, a plain click on a link in a rendered
//! preview — or a form posted from one — replaces the editor with whatever the
//! document chose, inside the app's chrome and with the editor state gone.
//! The frontend intercepts those clicks; this is the backstop that holds when
//! it does not.
//!
//! Key decisions:
//!   - It is a PLUGIN hook, not a per-window `on_navigation`. The `main`
//!     window is created by Tauri from `tauri.conf.json`, so it has no
//!     `WebviewWindowBuilder` to hang a handler on, and it is the window the
//!     rule matters most for. Tauri consults every plugin's hook for every
//!     webview at navigation time, however the webview was created.
//!   - The decision cannot see WHICH FRAME is navigating. On macOS and Linux
//!     the runtime asks for a sub-frame navigation exactly as it asks for a
//!     main-frame one, with only the URL. So the allowed set is the app's own
//!     origin plus what the app itself frames — the same set the CSP's
//!     `frame-src` names — and nothing a document could choose. A test pins
//!     the two together: widening `frame-src` fails until this agrees.
//!   - The outside origins the app frames (the video embeds) are READ from the
//!     CSP's `frame-src`, every `https:` source in it, rather than listed
//!     here: the CSP is what a release build enforces, so the guard and the
//!     CSP cannot disagree about them. The frontend's embed builder declares
//!     the same origins, and a frontend test holds `frame-src` to them.
//!   - `asset:` is NOT allowed, although it is the app's own protocol. It
//!     serves any granted local file, images and media load from it as
//!     subresources (never a navigation), and an HTML file lying next to a
//!     hostile document would otherwise open full-frame in the app's window.
//!   - A dev build is wider, because it enforces no CSP at all (the page comes
//!     from the dev server, which sends none): the Knowledge Base frame on its
//!     loopback port loads there today, and denying it would break a feature
//!     only a dev build can show.
//!   - The PDF renderer's throwaway windows are not governed. They hold no
//!     capability, show no app UI, and exist to load one staged file; their
//!     own one-shot navigation logic is the policy there.
//!   - The embedded browser's pages are not Tauri webviews, so no hook here
//!     reaches them and their navigation policy is untouched.
//!
//! @coordinates-with app_plugins.rs — registers the plugin
//! @coordinates-with trusted_html/protocol.rs — the trusted-preview scheme
//! @coordinates-with pdf_export/renderer — the ungoverned render windows
//! @coordinates-with src-tauri/tauri.conf.json — `frame-src` names the outside origins framed
//! @coordinates-with src/utils/videoProviderRegistry.ts — the embed origins the frontend builds
//! @module window_manager/navigation_guard

use std::sync::OnceLock;

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::utils::config::{Csp, SecurityConfig};
use tauri::{Manager, Runtime, Url};
use url::Origin;

use crate::peer_text::peer_text;
use crate::trusted_html::protocol::SCHEME as TRUSTED_SCHEME;

/// Host of every custom-protocol URL where protocols are schemes.
const PROTOCOL_HOST: &str = "localhost";

/// The label prefix `pdf_export::renderer` gives its throwaway windows off
/// macOS. Spelled here because that constant is private to two `cfg`-gated
/// modules; a test holds the two spellings together.
const RENDER_WINDOW_LABEL_PREFIX: &str = "pdf-render-";

/// What this build's own pages are served from, and what they frame.
#[derive(Clone, Copy, Debug)]
pub(crate) struct AppOrigins<'a> {
    /// The dev server, in a dev build; `None` in a release build.
    pub dev_url: Option<&'a Url>,
    /// Whether custom protocols are reached over `http://<scheme>.localhost`
    /// (Windows, Android) rather than `<scheme>://localhost`.
    pub http_custom_protocols: bool,
    /// The outside origins the app frames: [`framed_origins`] of the CSP.
    pub framed: &'a [Origin],
}

/// The sources a CSP lists for `directive`, in order; none when the CSP does
/// not name it.
fn csp_directive_sources<'c>(csp: &'c str, directive: &str) -> Vec<&'c str> {
    csp.split(';')
        .map(str::split_whitespace)
        .find_map(|mut parts| (parts.next() == Some(directive)).then(|| parts.collect()))
        .unwrap_or_default()
}

/// The outside origins a CSP lets the app frame: every `https:` source of
/// its `frame-src`. The other sources there are the app's own frames, which
/// [`navigation_allowed`] recognizes in each platform's form.
fn framed_origins(csp: &str) -> Vec<Origin> {
    csp_directive_sources(csp, "frame-src")
        .into_iter()
        .filter(|source| source.starts_with("https://"))
        .filter_map(|source| Url::parse(source).ok())
        .map(|source| source.origin())
        .collect()
}

/// The CSP a build injects: the dev policy in a dev build when one is set,
/// the release policy otherwise — the choice Tauri itself makes.
fn effective_csp(security: &SecurityConfig, dev: bool) -> Option<&Csp> {
    if dev {
        security.dev_csp.as_ref().or(security.csp.as_ref())
    } else {
        security.csp.as_ref()
    }
}

/// `about:blank` and `about:srcdoc`: what an empty or `srcdoc` frame loads.
fn is_inert_about_page(url: &Url) -> bool {
    url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc") && url.query().is_none()
}

/// `http://<name>.localhost` on its default port, or `https://` when allowed.
fn is_http_protocol_origin(url: &Url, name: &str, allow_https: bool) -> bool {
    let scheme_ok = url.scheme() == "http" || (allow_https && url.scheme() == "https");
    scheme_ok
        && url.port().is_none()
        && url
            .host_str()
            .and_then(|host| host.strip_suffix(".localhost"))
            == Some(name)
}

/// The origin a release build's own pages have.
fn is_release_app_page(url: &Url, http_custom_protocols: bool) -> bool {
    if http_custom_protocols {
        // `https` too: a window may opt into it, and `.localhost` never
        // resolves off the machine.
        is_http_protocol_origin(url, "tauri", true)
    } else {
        url.scheme() == "tauri" && url.host_str() == Some(PROTOCOL_HOST) && url.port().is_none()
    }
}

/// The trusted HTML preview's frame, in this platform's form.
fn is_trusted_preview_frame(url: &Url, http_custom_protocols: bool) -> bool {
    if http_custom_protocols {
        is_http_protocol_origin(url, TRUSTED_SCHEME, false)
    } else {
        url.scheme() == TRUSTED_SCHEME
    }
}

/// What only a dev build frames: the Knowledge Base content server on a
/// loopback port.
fn is_dev_only_frame(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
}

/// Whether an app webview may navigate to `url`.
pub(crate) fn navigation_allowed(url: &Url, origins: AppOrigins<'_>) -> bool {
    if is_inert_about_page(url) {
        return true;
    }
    // No page the app loads is ever addressed with credentials.
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if is_trusted_preview_frame(url, origins.http_custom_protocols) {
        return true;
    }
    // An origin compares scheme, host and port: a provider's other hosts,
    // plain http and another port are all different origins.
    if origins.framed.contains(&url.origin()) {
        return true;
    }
    match origins.dev_url {
        Some(dev_url) => url.origin() == dev_url.origin() || is_dev_only_frame(url),
        None => is_release_app_page(url, origins.http_custom_protocols),
    }
}

/// Whether the webview labelled `label` is governed by this guard.
fn governs(label: &str) -> bool {
    !label.starts_with(RENDER_WINDOW_LABEL_PREFIX)
}

/// The plugin that applies [`navigation_allowed`] to every app webview.
pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    // Read once: the config, and so the CSP, is fixed for the process.
    let framed = OnceLock::<Vec<Origin>>::new();
    PluginBuilder::new("vmark-navigation-guard")
        .on_navigation(move |webview, url| {
            let label = webview.label();
            if !governs(label) {
                return true;
            }
            let config = webview.app_handle().config();
            let dev = tauri::is_dev();
            let framed = framed.get_or_init(|| {
                effective_csp(&config.app.security, dev)
                    .map(|csp| framed_origins(&csp.to_string()))
                    .unwrap_or_default()
            });
            let origins = AppOrigins {
                dev_url: config.build.dev_url.as_ref().filter(|_| dev),
                http_custom_protocols: cfg!(any(windows, target_os = "android")),
                framed,
            };
            let allowed = navigation_allowed(url, origins);
            if !allowed {
                // Scheme and host only: the rest of a URL can carry a token or
                // a path, and all of it is text the document chose.
                log::warn!(
                    "[navigation] blocked {}: {} on {}",
                    peer_text(label),
                    peer_text(url.scheme()),
                    peer_text(url.host_str().unwrap_or("")),
                );
            }
            allowed
        })
        .build()
}

#[cfg(test)]
#[path = "navigation_guard.test.rs"]
mod tests;
