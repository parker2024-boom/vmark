// WI-RA12A.4 — the `URL` observer treats the object a notification names as a
// webview only after the Objective-C runtime confirms it is one.
//
// The positive half (a real `WKWebView` is recognized) needs the main thread and
// lives in the probe of `nav_api_navigation_native.test.rs`.

use super::observed_web_view;
use objc2::runtime::{AnyObject, NSObject};
use objc2_foundation::{NSString, NSURLRequest, NSURL};

#[test]
fn an_object_that_is_not_a_web_view_is_refused() {
    let plain = NSObject::new();
    let plain: &AnyObject = plain.as_ref();
    assert!(observed_web_view(plain).is_none(), "a bare NSObject");

    let string = NSString::from_str("https://example.com/");
    let string: &AnyObject = string.as_ref();
    assert!(observed_web_view(string).is_none(), "an NSString");
}

#[test]
fn an_object_that_merely_answers_url_is_refused() {
    // The dangerous impostor: it responds to `URL`, so reading it as a webview
    // would not fail at the first message — it would record the request's URL as
    // the page the tab had navigated to.
    let url =
        NSURL::URLWithString(&NSString::from_str("https://example.com/")).expect("a valid URL");
    let request = NSURLRequest::requestWithURL(&url);
    let request: &AnyObject = request.as_ref();
    assert!(observed_web_view(request).is_none());
}
