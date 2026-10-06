//! The plain WebKit calls the browser surface makes, each wrapped once.
//!
//! objc2's WebKit bindings mark most methods `unsafe` because the framework has
//! not been reviewed method by method, not because each call hides a
//! precondition. For every call in this file the whole precondition is "a live
//! object, messaged on the main thread", and the argument types already carry
//! it: `WKWebView`, `WKWebViewConfiguration` and `WKNavigationAction` are
//! main-thread-only types, so a reference to one can only exist on the main
//! thread and always borrows a live object; a `MainThreadMarker` proves the
//! thread where there is no receiver. That is stated once per call here instead
//! of at every call site, and the wrappers are safe functions because their
//! signatures are the proof.
//!
//! A call with a precondition of its own does NOT belong here — a block WebKit
//! keeps and calls later, an API that exists only on some OS versions, a raw
//! pointer. Its `unsafe` stays at the call site, with the reason.
//!
//! A `#[path]` child of surface_macos.rs; `pub(super)` reaches that module and
//! everything below it.

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSString, NSURLRequest};
use objc2_web_kit::{
    WKContentRuleList, WKContentWorld, WKHTTPCookieStore, WKNavigationAction, WKUserScript,
    WKUserScriptInjectionTime, WKWebView, WKWebViewConfiguration,
};

/// `loadRequest:` — whether WebKit created a navigation.
pub(super) fn load_request(web_view: &WKWebView, request: &NSURLRequest) -> bool {
    // SAFETY: a live webview on the main thread (module header) and a live
    // request, which WebKit copies; `loadRequest:` asks for nothing else.
    unsafe { web_view.loadRequest(request) }.is_some()
}

/// One step through the back/forward list (`goForward` or `goBack`) — whether
/// there was an item to navigate to.
pub(super) fn go_history(web_view: &WKWebView, forward: bool) -> bool {
    // SAFETY: a live webview on the main thread; with no item in that direction
    // WebKit returns nil rather than failing.
    let navigation = unsafe {
        if forward {
            web_view.goForward()
        } else {
            web_view.goBack()
        }
    };
    navigation.is_some()
}

/// `reload` — whether there was a page to reload.
pub(super) fn reload(web_view: &WKWebView) -> bool {
    // SAFETY: a live webview on the main thread; with nothing to reload WebKit
    // returns nil rather than failing.
    unsafe { web_view.reload() }.is_some()
}

/// `stopLoading`. A no-op when nothing is loading.
pub(super) fn stop_loading(web_view: &WKWebView) {
    // SAFETY: a live webview on the main thread; the call takes no arguments.
    unsafe { web_view.stopLoading() };
}

/// The `loading` property.
pub(super) fn is_loading(web_view: &WKWebView) -> bool {
    // SAFETY: a property read on a live webview on the main thread.
    unsafe { web_view.isLoading() }
}

/// The webview's cookie store (its configuration's data store's).
pub(super) fn cookie_store(web_view: &WKWebView) -> Retained<WKHTTPCookieStore> {
    // SAFETY: three property reads on a live webview on the main thread; each
    // returns a non-null object that the result retains.
    unsafe {
        web_view
            .configuration()
            .websiteDataStore()
            .httpCookieStore()
    }
}

/// The page's own content world — the one its scripts run in.
pub(super) fn page_world(mtm: MainThreadMarker) -> Retained<WKContentWorld> {
    // SAFETY: a class property read; `mtm` proves the main thread, which is all
    // this main-thread-only class requires.
    unsafe { WKContentWorld::pageWorld(mtm) }
}

/// The URL a navigation action is headed for, or empty when it has none.
pub(super) fn action_url(action: &WKNavigationAction) -> String {
    // SAFETY: a property read on a live action on the main thread; it returns
    // the action's request, retained.
    unsafe { action.request() }
        .URL()
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_default()
}

/// Whether a navigation action targets the main frame: `None` when it has no
/// target frame at all (a new-window request), otherwise the frame's answer.
pub(super) fn targets_main_frame(action: &WKNavigationAction) -> Option<bool> {
    // SAFETY: a property read on a live action on the main thread; nil (no
    // target frame) comes back as `None`.
    let frame = unsafe { action.targetFrame() }?;
    // SAFETY: a property read on the frame info just returned, still retained.
    Some(unsafe { frame.isMainFrame() })
}

/// Add a script to `config` that runs in the page world at document start, in
/// the main frame only or in every frame.
///
/// A user script is configuration-time: it reaches only webviews built from
/// `config` afterwards.
pub(super) fn add_page_world_script(
    config: &WKWebViewConfiguration,
    mtm: MainThreadMarker,
    source: &str,
    main_frame_only: bool,
) {
    let source = NSString::from_str(source);
    let world = page_world(mtm);
    // SAFETY: initializes the script allocated on this line exactly once, with a
    // live source string, a valid injection-time value and a live content world.
    let script = unsafe {
        WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
            WKUserScript::alloc(mtm),
            &source,
            WKUserScriptInjectionTime::AtDocumentStart,
            main_frame_only,
            &world,
        )
    };
    // SAFETY: a property read on a live configuration on the main thread, then a
    // call that hands the controller a fully initialized script, which it retains.
    unsafe { config.userContentController().addUserScript(&script) };
}

/// Attach a compiled content rule list to `config`.
pub(super) fn add_content_rule_list(config: &WKWebViewConfiguration, list: &WKContentRuleList) {
    // SAFETY: a property read on a live configuration on the main thread, then a
    // call that hands the controller a compiled list, which it retains.
    unsafe { config.userContentController().addContentRuleList(list) };
}
