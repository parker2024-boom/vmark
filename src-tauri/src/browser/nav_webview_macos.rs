//! Reads off the live `WKWebView` for the nav delegate — current URL, title, and
//! back/forward-list state. Split from nav_delegate_macos.rs to keep it under the
//! file-size limit; a `#[path]` submodule of `nav_delegate`.
//!
//! These are deliberately *reads*, never a mirror: WebKit owns the URL, the title,
//! and the back/forward list, and a redirect, a same-document push, or a `goBack()`
//! all mutate them without any command passing through us. Re-reading at each event
//! is what keeps the chrome honest.

use objc2::runtime::AnyObject;
use objc2_web_kit::WKWebView;

/// The object a key-value observation names, as a webview — or `None` when it is
/// not one.
///
/// `observeValueForKeyPath:ofObject:change:context:` hands every observer an
/// untyped `id`. The delegate registers itself on exactly one webview, so that is
/// what arrives today; but nothing in the method's signature says so, and a
/// subclass, a second registration or a stray message would deliver something
/// else. The runtime is asked (`isKindOfClass:`) rather than trusted, so an
/// impostor is ignored instead of being messaged as a `WKWebView`.
pub(super) fn observed_web_view(object: &AnyObject) -> Option<&WKWebView> {
    object.downcast_ref::<WKWebView>()
}

pub(super) fn current_url(web_view: &WKWebView) -> String {
    // SAFETY: a property read on a live webview; `WKWebView` is a
    // main-thread-only type, so holding `&WKWebView` means this is that thread.
    unsafe { web_view.URL() }
        .and_then(|u| u.absoluteString())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

pub(super) fn current_title(web_view: &WKWebView) -> String {
    // SAFETY: as `current_url` — a property read on a live webview on the main
    // thread.
    unsafe { web_view.title() }
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// The webview's back/forward-list state as `(can_go_back, can_go_forward)`.
///
/// The omnibox disables its history controls from these, so a stale mirror would be
/// worse than no state at all — hence the direct read.
pub(super) fn history_state(web_view: &WKWebView) -> (bool, bool) {
    // SAFETY: as `current_url` — two property reads on a live webview on the
    // main thread.
    unsafe { (web_view.canGoBack(), web_view.canGoForward()) }
}

#[cfg(test)]
#[path = "nav_webview_macos.test.rs"]
mod tests;
