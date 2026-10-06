//! WI-RA7.4 — an open that arrives after `main` has been destroyed is
//! delivered to a NEW main window, end to end, on a mock app.
//!
//! The state rule is pinned in `file_open_state.test.rs`. These tests run the
//! real path around it: the `Destroyed` hook, `route_file_opens`, the window
//! build, and the drain the new window's frontend performs. Each mock app has
//! its own store, so they do not see one another's state.

// `tauri::test` does not exist on Windows (see Cargo.toml's target-specific
// dev-dependency); every mock-runtime suite in this crate is gated to match.
#![cfg(not(target_os = "windows"))]

use tauri::test::MockRuntime;
use tauri::Manager;

use super::file_open_state;
use crate::files::open::{get_pending_file_opens, remove_document_window, route_file_opens};
use crate::window_manager::{QueueOwner, MAIN_LABEL};

fn mock_app() -> tauri::App<MockRuntime> {
    tauri::test::mock_builder()
        .plugin(tauri_plugin_fs::init())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

/// What the frontend of `label` gets when it mounts and drains the queue.
fn drain_as(app: &tauri::App<MockRuntime>, label: &str) -> Vec<String> {
    let window = app.get_webview_window(label).expect("the window exists");
    let window = AsRef::<tauri::Webview<_>>::as_ref(&window).window();
    get_pending_file_opens(window)
        .into_iter()
        .map(|open| open.path)
        .collect()
}

#[test]
fn every_app_has_its_own_store_and_it_starts_with_main_booting() {
    let one = mock_app();
    let other = mock_app();

    file_open_state(one.handle()).lock().owner = QueueOwner::Settled;

    assert_eq!(
        file_open_state(one.handle()).lock().owner,
        QueueOwner::Settled,
        "the same store is handed back on every use"
    );
    assert_eq!(
        file_open_state(other.handle()).lock().owner,
        QueueOwner::Booting
    );
}

#[test]
fn a_poisoned_store_still_hands_out_its_state() {
    let app = mock_app();
    let store = file_open_state(app.handle());
    let poisoned = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let _guard = store.lock();
                panic!("poison the file-open store (expected by this test)");
            })
            .join()
    });
    assert!(poisoned.is_err(), "the holder must have panicked");

    store.queue_launch_file_args(vec!["/docs/笔记.md".to_string()]);
    assert_eq!(store.lock().pending.len(), 1);
}

#[test]
fn an_open_after_main_was_destroyed_undrained_is_delivered_to_a_new_main_window() {
    let app = mock_app();
    // Cold start: the first open is queued for the main window that is
    // booting. No window exists in this app, which is the point: that main
    // was destroyed before its frontend ever drained the queue.
    route_file_opens(app.handle(), vec!["/docs/cold.md".to_string()]);
    assert!(
        app.webview_windows().is_empty(),
        "an open during boot waits for the booting window"
    );
    remove_document_window(app.handle(), MAIN_LABEL);

    route_file_opens(app.handle(), vec!["/docs/笔记/next.md".to_string()]);

    assert!(
        app.get_webview_window(MAIN_LABEL).is_some(),
        "nobody was left to drain the queue, so a new main window is built"
    );
    assert_eq!(app.webview_windows().len(), 1);
    assert_eq!(
        drain_as(&app, MAIN_LABEL),
        vec!["/docs/cold.md", "/docs/笔记/next.md"],
        "the new window receives the open that was stranded and the one that revived it"
    );
}

#[test]
fn opens_arriving_while_the_new_main_boots_join_its_queue_and_build_nothing_more() {
    let app = mock_app();
    remove_document_window(app.handle(), MAIN_LABEL);

    route_file_opens(app.handle(), vec!["/a/one.md".to_string()]);
    route_file_opens(app.handle(), vec!["/b/two.md".to_string()]);
    route_file_opens(app.handle(), Vec::new());

    assert_eq!(app.webview_windows().len(), 1, "one main window");
    assert_eq!(drain_as(&app, MAIN_LABEL), vec!["/a/one.md", "/b/two.md"]);
    assert!(drain_as(&app, MAIN_LABEL).is_empty(), "a drain is a take");
}

#[test]
fn once_main_has_drained_a_later_open_is_emitted_to_it_not_queued() {
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    let app = mock_app();
    remove_document_window(app.handle(), MAIN_LABEL);
    route_file_opens(app.handle(), vec!["/a/one.md".to_string()]);
    assert_eq!(drain_as(&app, MAIN_LABEL), vec!["/a/one.md"]);

    let emitted = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&emitted);
    app.listen_any("app:open-file", move |event| {
        seen.lock()
            .expect("capture")
            .push(event.payload().to_string());
    });

    route_file_opens(app.handle(), vec!["/a/two.md".to_string()]);

    let emitted = emitted.lock().expect("capture");
    assert_eq!(emitted.len(), 1, "{emitted:?}");
    assert!(emitted[0].contains("/a/two.md") && emitted[0].contains("\"main\""));
    assert!(file_open_state(app.handle()).lock().pending.is_empty());
    assert_eq!(app.webview_windows().len(), 1);
}
