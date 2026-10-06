//! WI-RA7.3 — the quit request honours window readiness, and a quit that
//! stalls stops swallowing retries.
//! WI-RA25.2 — Save All and Quit is a mode of the same quit: every window is
//! told to save everything, a booting window is told so when it is ready, and
//! a request for more than the running quit asks is never swallowed.
//!
//! The defect: Cmd+N then Cmd+Q during boot emitted `app:quit-requested` to a
//! window whose listeners were not registered yet. The request went nowhere,
//! the window stayed a quit target, and `QUIT_IN_PROGRESS` swallowed every
//! later Cmd+Q for the life of the process.

use std::time::{Duration, Instant};

use super::super::{cancel_quit, is_quit_in_progress, tests::TEST_LOCK};
use super::*;

/// Serialize with every other test that touches the quit statics, and start
/// from "no quit in progress".
fn quit_state() -> std::sync::MutexGuard<'static, ()> {
    let guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    cancel_quit();
    guard
}

// -- which request starts, restarts or duplicates a quit ----------------------

#[test]
fn the_first_request_starts_the_quit() {
    let _lock = quit_state();
    assert_eq!(
        claim_quit_attempt(Instant::now(), QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );
    assert!(is_quit_in_progress());
    cancel_quit();
}

#[test]
fn a_repeat_inside_the_retry_window_is_a_duplicate() {
    let _lock = quit_state();
    let start = Instant::now();
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );

    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::AlreadyRunning
    );
    let just_inside = start + QUIT_RETRY_AFTER - Duration::from_millis(1);
    assert_eq!(
        claim_quit_attempt(just_inside, QuitMode::Prompt),
        QuitAttempt::AlreadyRunning
    );
    cancel_quit();
}

#[test]
fn a_quit_still_unfinished_after_the_retry_window_is_asked_again() {
    let _lock = quit_state();
    let start = Instant::now();
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );

    let stalled = start + QUIT_RETRY_AFTER;
    assert_eq!(
        claim_quit_attempt(stalled, QuitMode::Prompt),
        QuitAttempt::Retry(QuitMode::Prompt),
        "a stalled quit must not swallow the user's next Cmd+Q"
    );
    assert!(is_quit_in_progress(), "the quit is still the same quit");

    // The retry restarts the clock: an immediate repeat is a duplicate again,
    // and a later one is honoured again.
    assert_eq!(
        claim_quit_attempt(stalled + Duration::from_secs(1), QuitMode::Prompt),
        QuitAttempt::AlreadyRunning
    );
    assert_eq!(
        claim_quit_attempt(stalled + QUIT_RETRY_AFTER * 3, QuitMode::Prompt),
        QuitAttempt::Retry(QuitMode::Prompt)
    );
    cancel_quit();
}

#[test]
fn a_request_stamped_before_the_quit_started_is_a_duplicate_not_a_panic() {
    // `Instant`s are taken on different threads; one can be a hair older than
    // the start it is compared with.
    let _lock = quit_state();
    let start = Instant::now() + Duration::from_secs(5);
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );
    assert_eq!(
        claim_quit_attempt(start - Duration::from_secs(5), QuitMode::Prompt),
        QuitAttempt::AlreadyRunning
    );
    cancel_quit();
}

#[test]
fn a_cancelled_quit_leaves_the_next_request_fresh() {
    let _lock = quit_state();
    let start = Instant::now();
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );

    cancel_quit();

    assert!(!is_quit_in_progress());
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );
    cancel_quit();
}

// -- Save All and Quit: the save-everything mode ---------------------------------

#[test]
fn save_all_and_quit_starts_a_quit_that_saves_everything() {
    let _lock = quit_state();
    assert_eq!(
        claim_quit_attempt(Instant::now(), QuitMode::SaveAll),
        QuitAttempt::Fresh(QuitMode::SaveAll)
    );
    assert!(is_quit_in_progress());
    cancel_quit();
}

#[test]
fn save_all_while_a_quit_is_asking_is_not_a_duplicate() {
    // Cmd+Q, then Save All and Quit a moment later: the second asks for more
    // than the first, and swallowing it would leave windows prompting.
    let _lock = quit_state();
    let start = Instant::now();
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );

    let moment_later = start + Duration::from_millis(500);
    assert_eq!(
        claim_quit_attempt(moment_later, QuitMode::SaveAll),
        QuitAttempt::Retry(QuitMode::SaveAll),
        "every remaining window is asked again, to save everything"
    );
    assert!(is_quit_in_progress(), "the quit is still the same quit");
    // Now the quit saves everything; a repeat of either request is a duplicate.
    assert_eq!(
        claim_quit_attempt(moment_later, QuitMode::SaveAll),
        QuitAttempt::AlreadyRunning
    );
    assert_eq!(
        claim_quit_attempt(moment_later, QuitMode::Prompt),
        QuitAttempt::AlreadyRunning
    );
    cancel_quit();
}

#[test]
fn a_quit_that_saves_everything_is_never_downgraded_to_asking() {
    let _lock = quit_state();
    let start = Instant::now();
    assert_eq!(
        claim_quit_attempt(start, QuitMode::SaveAll),
        QuitAttempt::Fresh(QuitMode::SaveAll)
    );
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::AlreadyRunning
    );
    assert_eq!(
        claim_quit_attempt(start + QUIT_RETRY_AFTER, QuitMode::Prompt),
        QuitAttempt::Retry(QuitMode::SaveAll),
        "a stalled save-all quit asked again by Cmd+Q still saves everything"
    );
    cancel_quit();
}

#[test]
fn a_cancelled_save_all_quit_leaves_the_next_quit_asking() {
    let _lock = quit_state();
    let start = Instant::now();
    claim_quit_attempt(start, QuitMode::SaveAll);
    cancel_quit();
    assert_eq!(
        claim_quit_attempt(start, QuitMode::Prompt),
        QuitAttempt::Fresh(QuitMode::Prompt)
    );
    cancel_quit();
}

// -- who is asked, and when ----------------------------------------------------
//
// `tauri::test` does not exist on Windows (see Cargo.toml's target-specific
// dev-dependency); every mock-runtime test in this crate is gated to match.

#[cfg(not(target_os = "windows"))]
mod on_a_mock_app {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};
    use tauri::test::MockRuntime;
    use tauri::{Listener, WebviewWindow};

    use super::super::{request_quit_of, QuitMode, QUIT_REQUESTED_EVENT};
    use super::{cancel_quit, quit_state};
    use crate::menu;

    fn mock_app() -> tauri::App<MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app")
    }

    /// A document window under a label no other test uses: window readiness is
    /// recorded per label for the whole process.
    fn document_window(
        app: &tauri::App<MockRuntime>,
        label: &str,
    ) -> (String, WebviewWindow<MockRuntime>) {
        let window =
            tauri::webview::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
                .visible(false)
                .build()
                .expect("build mock document window");
        (label.to_string(), window)
    }

    /// Every `app:quit-requested` payload the app's windows are sent.
    fn quit_requests(app: &tauri::App<MockRuntime>) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        app.listen_any(QUIT_REQUESTED_EVENT, move |event| {
            sink.lock()
                .expect("capture")
                .push(event.payload().to_string());
        });
        seen
    }

    fn received(requests: &Arc<Mutex<Vec<String>>>) -> Vec<Value> {
        requests
            .lock()
            .expect("capture")
            .iter()
            .map(|payload| serde_json::from_str(payload).expect("a quit request is JSON"))
            .collect()
    }

    /// The request a window gets in a quit that asks about each document. It
    /// names the window: an emit reaches every window, and each answers only
    /// its own.
    fn asking(label: &str) -> Value {
        json!({ "label": label, "saveAll": false })
    }

    /// The request a window gets in Save All and Quit.
    fn saving_all(label: &str) -> Value {
        json!({ "label": label, "saveAll": true })
    }

    #[test]
    fn save_all_and_quit_tells_every_window_to_save_everything() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [
            document_window(&app, "doc-70311"),
            document_window(&app, "doc-70312"),
        ];
        menu::events::mark_window_ready(app.handle(), "doc-70311");
        menu::events::mark_window_ready(app.handle(), "doc-70312");

        request_quit_of(&windows, QuitMode::SaveAll).expect("emit");

        assert_eq!(
            received(&requests),
            vec![saving_all("doc-70311"), saving_all("doc-70312")],
            "every window saves, not only the one the command was chosen in"
        );
        menu::events::clear_window_ready("doc-70311");
        menu::events::clear_window_ready("doc-70312");
    }

    #[test]
    fn a_window_still_starting_is_told_to_save_everything_when_it_is_ready() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [document_window(&app, "doc-70313")];

        request_quit_of(&windows, QuitMode::SaveAll).expect("deferred");
        assert!(received(&requests).is_empty());

        menu::events::mark_window_ready(app.handle(), "doc-70313");
        assert_eq!(received(&requests), vec![saving_all("doc-70313")]);
        menu::events::clear_window_ready("doc-70313");
    }

    #[test]
    fn a_window_still_starting_asked_again_to_save_everything_gets_that_request_once() {
        // Cmd+Q reached a booting window, then Save All and Quit escalated the
        // quit before it finished starting: it must save, and be asked once.
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [document_window(&app, "doc-70314")];

        request_quit_of(&windows, QuitMode::Prompt).expect("first ask");
        request_quit_of(&windows, QuitMode::SaveAll).expect("the escalation");
        menu::events::mark_window_ready(app.handle(), "doc-70314");

        assert_eq!(received(&requests), vec![saving_all("doc-70314")]);
        menu::events::clear_window_ready("doc-70314");
    }

    #[test]
    fn a_cancelled_save_all_quit_withdraws_its_request_from_a_window_still_starting() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [document_window(&app, "doc-70315")];
        request_quit_of(&windows, QuitMode::SaveAll).expect("deferred");

        // A save failed in another window, which cancelled the quit.
        cancel_quit();
        menu::events::mark_window_ready(app.handle(), "doc-70315");

        assert!(received(&requests).is_empty());
        menu::events::clear_window_ready("doc-70315");
    }

    #[test]
    fn a_window_that_is_listening_is_asked_at_once() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [document_window(&app, "doc-70301")];
        menu::events::mark_window_ready(app.handle(), "doc-70301");

        request_quit_of(&windows, QuitMode::Prompt).expect("emit");

        assert_eq!(received(&requests), vec![asking("doc-70301")]);
        menu::events::clear_window_ready("doc-70301");
    }

    #[test]
    fn a_window_still_starting_is_asked_when_it_becomes_ready_not_before() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [document_window(&app, "doc-70302")];

        request_quit_of(&windows, QuitMode::Prompt).expect("a deferred request is not a failure");
        assert!(
            received(&requests).is_empty(),
            "a request emitted before the frontend listens is a request lost"
        );

        menu::events::mark_window_ready(app.handle(), "doc-70302");
        assert_eq!(received(&requests), vec![asking("doc-70302")]);
        menu::events::clear_window_ready("doc-70302");
    }

    #[test]
    fn asking_again_does_not_queue_a_second_request_for_a_window_still_starting() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [document_window(&app, "doc-70303")];

        request_quit_of(&windows, QuitMode::Prompt).expect("first ask");
        request_quit_of(&windows, QuitMode::Prompt).expect("the retry");
        menu::events::mark_window_ready(app.handle(), "doc-70303");

        assert_eq!(
            received(&requests).len(),
            1,
            "one request, however often asked"
        );
        menu::events::clear_window_ready("doc-70303");
    }

    #[test]
    fn a_cancelled_quit_withdraws_its_request_from_a_window_still_starting() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [document_window(&app, "doc-70304")];
        request_quit_of(&windows, QuitMode::Prompt).expect("deferred");

        // The user cancelled a save prompt in another window.
        cancel_quit();
        menu::events::mark_window_ready(app.handle(), "doc-70304");

        assert!(
            received(&requests).is_empty(),
            "a window that finishes starting after the quit was called off must not be closed by it"
        );
        menu::events::clear_window_ready("doc-70304");
    }

    #[test]
    fn listening_and_starting_windows_are_each_handled_in_one_broadcast() {
        let _lock = quit_state();
        let app = mock_app();
        let requests = quit_requests(&app);
        let windows = [
            document_window(&app, "doc-70305"),
            document_window(&app, "doc-70306"),
        ];
        menu::events::mark_window_ready(app.handle(), "doc-70305");

        request_quit_of(&windows, QuitMode::Prompt).expect("emit");
        assert_eq!(received(&requests), vec![asking("doc-70305")]);

        menu::events::mark_window_ready(app.handle(), "doc-70306");
        assert_eq!(
            received(&requests),
            vec![asking("doc-70305"), asking("doc-70306")]
        );
        menu::events::clear_window_ready("doc-70305");
        menu::events::clear_window_ready("doc-70306");
    }
}
