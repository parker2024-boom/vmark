//! Tests for `settings_window.rs` (included via `#[path]`).
//!
//! `show_settings_window_section` itself needs a live Tauri runtime, so what
//! is covered here is the pure part it delegates to: turning an optional
//! section into the URL the Settings window is built with. That URL is the
//! one difference between the two Settings entry points (#1141), so it is
//! worth pinning down exactly.

use super::*;

#[test]
fn no_section_is_the_bare_route() {
    assert_eq!(settings_url(None), "/settings");
}

#[test]
fn section_becomes_a_query_param() {
    assert_eq!(
        settings_url(Some("integrations")),
        "/settings?section=integrations"
    );
}

/// Every section the frontend's `validSections` accepts must survive the
/// round trip unescaped — they are all plain lowercase words, so a section
/// that comes back percent-mangled means the encoder was applied too broadly.
#[test]
fn known_sections_round_trip_unescaped() {
    for section in [
        "about",
        "appearance",
        "editor",
        "files",
        "formats",
        "integrations",
        "language",
        "markdown",
        "shortcuts",
        "terminal",
        "advanced",
    ] {
        assert_eq!(
            settings_url(Some(section)),
            format!("/settings?section={section}"),
            "section `{section}` should not be escaped"
        );
    }
}

/// A section carrying reserved URL characters must not be able to smuggle in
/// extra query params or a fragment.
#[test]
fn reserved_characters_are_percent_encoded() {
    let url = settings_url(Some("a&b=c#d?e"));
    assert!(
        !url.contains('&') && !url.contains('#'),
        "reserved chars must be encoded, got {url}"
    );
    assert_eq!(url, "/settings?section=a%26b%3Dc%23d%3Fe");
}

#[test]
fn spaces_and_unicode_are_encoded() {
    assert_eq!(settings_url(Some("a b")), "/settings?section=a%20b");
    assert_eq!(
        settings_url(Some("中文")),
        "/settings?section=%E4%B8%AD%E6%96%87"
    );
}

/// The command filters empty sections to `None` before calling through, but
/// the builder should still be well-behaved if one arrives: an empty query
/// value must not produce a route the SPA cannot match.
#[test]
fn empty_section_still_yields_a_matchable_route() {
    let url = settings_url(Some(""));
    assert!(
        url.starts_with("/settings"),
        "route must stay /settings, got {url}"
    );
}

// ---------------------------------------------------------------------------
// Idempotent creation (#1301)
//
// `open_settings_window` became `#[tauri::command(async)]` because a
// synchronous command builds the window on the main thread and deadlocks
// WebView2 on Windows. That removed the accidental serialization the blocking
// IPC loop used to provide: two clicks can now both see "no settings window"
// before either builds. Tauri does not stop both from building — it checks the
// label on the calling thread and registers it unconditionally afterwards — so
// the check and the build go through `ensure_window` as one step (WI-RA7.1),
// and a caller that arrives second focuses the window the first one built.

// tauri::test::MockRuntime crashes the test binary at startup on
// windows-latest (STATUS_ENTRYPOINT_NOT_FOUND). The `test` feature of tauri is
// not enabled on Windows (see Cargo.toml's target-specific dev-dependency), so
// `tauri::test` does not exist there and every caller is cfg-gated to match —
// the same treatment `fs_scope.test.rs` and `mcp_bridge/*.test.rs` already use.
// macOS/Linux still exercise the real runtime path.
#[cfg(not(target_os = "windows"))]
use tauri::Manager;

#[cfg(not(target_os = "windows"))]
fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

/// WI-RA7.1 — the race itself, not a stand-in for its loser. Tauri emits
/// `tauri://window-created` once per successful `build()`, so the count is the
/// number of native Settings windows the callers produced between them.
#[cfg(not(target_os = "windows"))]
#[test]
fn concurrent_opens_build_exactly_one_settings_window() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use tauri::Listener;

    const CALLERS: usize = 16;
    // A race is a matter of schedule: one round can pass by luck, fifty in a
    // row cannot.
    for round in 0..50 {
        let app = mock_app();
        let built = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&built);
        app.listen_any("tauri://window-created", move |event| {
            let payload: serde_json::Value =
                serde_json::from_str(event.payload()).expect("a JSON payload");
            if payload["label"] == SETTINGS_LABEL {
                seen.fetch_add(1, Ordering::SeqCst);
            }
        });
        let start = Arc::new(Barrier::new(CALLERS));

        let callers: Vec<_> = (0..CALLERS)
            .map(|caller| {
                let handle = app.handle().clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    let section = (caller % 2 == 0).then_some("about");
                    show_settings_window_section(&handle, section).map_err(|e| e.to_string())
                })
            })
            .collect();
        for caller in callers {
            let opened = caller.join().expect("an open must not panic");
            assert_eq!(
                opened.as_deref(),
                Ok(SETTINGS_LABEL),
                "round {round}: losing the race is not a failed open"
            );
        }

        assert_eq!(
            built.load(Ordering::SeqCst),
            1,
            "round {round}: Settings must be built once"
        );
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn a_second_open_focuses_the_existing_window_instead_of_creating_one() {
    let app = mock_app();
    let first = show_settings_window_section(app.handle(), None).expect("first open");
    let second = show_settings_window_section(app.handle(), Some("about")).expect("second open");

    assert_eq!(first, SETTINGS_LABEL);
    assert_eq!(second, SETTINGS_LABEL);
    assert_eq!(
        app.webview_windows()
            .keys()
            .filter(|l| *l == SETTINGS_LABEL)
            .count(),
        1,
        "Settings must stay a singleton"
    );
}

#[cfg(not(target_os = "windows"))]
#[test]
fn a_build_that_loses_the_race_reports_success_rather_than_label_already_exists() {
    let app = mock_app();
    // Stand in for the winning concurrent call: the label is already taken by
    // the time this call's `build()` runs, which is the whole losing case.
    let _winner = tauri::webview::WebviewWindowBuilder::new(
        app.handle(),
        SETTINGS_LABEL,
        tauri::WebviewUrl::default(),
    )
    .visible(false)
    .build()
    .expect("build the winning settings window");

    // Prove the premise rather than assuming it: a duplicate label must fail.
    let duplicate = tauri::webview::WebviewWindowBuilder::new(
        app.handle(),
        SETTINGS_LABEL,
        tauri::WebviewUrl::default(),
    )
    .build();
    assert!(
        duplicate.is_err(),
        "premise: a duplicate window label must be rejected by the runtime"
    );

    // The real entry point must nonetheless succeed — the user's window exists.
    let label = show_settings_window_section(app.handle(), Some("integrations"))
        .expect("losing the create race is not a user-visible failure");
    assert_eq!(label, SETTINGS_LABEL);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn an_open_on_a_live_window_navigates_it_and_a_first_open_does_not() {
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    let app = mock_app();
    let navigated = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&navigated);
    app.listen_any("settings:navigate", move |event| {
        seen.lock()
            .expect("capture")
            .push(event.payload().to_string());
    });

    // The first open carries its section in the URL, so there is nothing to
    // navigate; the second finds the window and has to tell it where to go.
    show_settings_window_section(app.handle(), Some("editor")).expect("first open");
    assert!(navigated.lock().expect("capture").is_empty());

    show_settings_window_section(app.handle(), Some("about")).expect("second open");
    assert_eq!(*navigated.lock().expect("capture"), vec!["\"about\""]);

    // No section asked for: reveal only.
    show_settings_window_section(app.handle(), None).expect("third open");
    assert_eq!(navigated.lock().expect("capture").len(), 1);
}
