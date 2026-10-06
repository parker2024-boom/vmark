// WI-RA14B.3 — the readiness queue a menu click goes through: an event for a
// window whose frontend is not listening yet is held and handed over, with
// its payload, the moment the window says it is ready; a destroyed window's
// queue is dropped; and a ready window is never queued for.
//
// Readiness is recorded per label for the whole process, so every test uses
// labels no other test does (`menu-ev-*`) and clears them when done.

use super::*;

#[test]
fn a_window_not_yet_ready_has_its_event_queued_and_a_ready_one_does_not() {
    let label = "menu-ev-check";

    assert!(!is_window_ready(label));
    assert!(!check_ready_or_queue(label, make_menu_event("menu:save")));
    assert_eq!(pending_names(label), vec!["menu:save"]);

    get_state()
        .get_or_insert_with(WindowReadyState::new)
        .ready_windows
        .insert(label.to_string());
    assert!(is_window_ready(label));
    assert!(check_ready_or_queue(label, make_menu_event("menu:print")));
    assert_eq!(pending_names(label), vec!["menu:save"], "nothing queued");

    clear_window_ready(label);
    assert!(!is_window_ready(label));
    assert!(pending_names(label).is_empty());
}

#[test]
fn withdrawing_an_event_removes_it_from_every_window_waiting_for_it() {
    let (a, b) = ("menu-ev-withdraw-a", "menu-ev-withdraw-b");
    queue_event(a, make_menu_event("app:quit-requested"));
    queue_event(a, make_menu_event("menu:save"));
    queue_event(b, make_menu_event("app:quit-requested"));

    withdraw_deferred("app:quit-requested");

    assert_eq!(pending_names(a), vec!["menu:save"]);
    assert!(pending_names(b).is_empty());
    clear_window_ready(a);
    clear_window_ready(b);
}

#[test]
fn recent_events_carry_their_path() {
    let file = make_recent_file_event("/notes/计划.md");
    let workspace = make_recent_workspace_event("/projects/vmark");

    assert_eq!(file.event_name, "menu:open-recent-file");
    assert_eq!(file.recent_file_path.as_deref(), Some("/notes/计划.md"));
    assert_eq!(workspace.event_name, "menu:open-recent-workspace");
    assert_eq!(
        workspace.recent_file_path.as_deref(),
        Some("/projects/vmark")
    );
    assert_eq!(make_menu_event("menu:new").recent_file_path, None);
}

fn pending_names(label: &str) -> Vec<String> {
    get_state()
        .as_ref()
        .and_then(|s| s.pending_events.get(label))
        .map(|events| events.iter().map(|e| e.event_name.clone()).collect())
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
mod on_a_mock_app {
    use std::sync::{Arc, Mutex};

    use tauri::test::MockRuntime;
    use tauri::Listener;

    use super::*;

    fn app_with_window(label: &str) -> tauri::App<MockRuntime> {
        let app = tauri::test::mock_app();
        tauri::webview::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
            .visible(false)
            .build()
            .expect("mock window");
        app
    }

    /// Every payload emitted under `event`, as JSON text, in order.
    fn payloads(app: &tauri::App<MockRuntime>, event: &str) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        app.listen_any(event, move |e| {
            sink.lock().unwrap().push(e.payload().to_string());
        });
        seen
    }

    #[test]
    fn queued_events_are_flushed_in_order_with_their_payload_when_the_window_is_ready() {
        let label = "menu-ev-flush";
        let app = app_with_window(label);
        let recent = payloads(&app, "menu:open-recent-file");
        let saves = payloads(&app, "menu:save");
        queue_event(label, make_menu_event("menu:save"));
        queue_event(label, make_recent_file_event("/a/one.md"));
        queue_event(label, make_recent_file_event("/a/two.md"));
        assert!(recent.lock().unwrap().is_empty(), "nothing before ready");

        mark_window_ready(app.handle(), label);

        assert_eq!(*saves.lock().unwrap(), vec![format!("\"{label}\"")]);
        assert_eq!(
            *recent.lock().unwrap(),
            vec![
                format!("[\"/a/one.md\",\"{label}\"]"),
                format!("[\"/a/two.md\",\"{label}\"]"),
            ]
        );
        // Flushed once: marking ready again sends nothing more.
        mark_window_ready(app.handle(), label);
        assert_eq!(recent.lock().unwrap().len(), 2);
        clear_window_ready(label);
    }

    #[test]
    fn a_destroyed_windows_queue_is_dropped_not_delivered_to_its_successor() {
        let label = "menu-ev-dropped";
        let app = app_with_window(label);
        let saves = payloads(&app, "menu:save");
        queue_event(label, make_menu_event("menu:save"));

        // The window goes away; a new one later reuses the label.
        clear_window_ready(label);
        mark_window_ready(app.handle(), label);

        assert!(saves.lock().unwrap().is_empty());
        clear_window_ready(label);
    }
}
