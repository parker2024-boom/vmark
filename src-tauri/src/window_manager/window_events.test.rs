//! Which windows have their close routed through the frontend (and, on
//! Windows, the close-to-tray decision, #1419).
//!
//! The handler used to carry its own copy of the document-window rule
//! (`label == "main" || label.starts_with("doc-")`) — one of seven copies of
//! the same rule across the crate. It now asks `quit::is_document_window_label`,
//! so the window whose close is intercepted and the window quit waits for can
//! never disagree. If they did, quit could wait on a window whose close was
//! never routed, or route one it never waits for.
//!
//! WI-RA7.7 — the `ready` payload is a label the webview chose; it reaches the
//! log escaped and bounded.

use super::{intercepts_close, ready_window_label};
use crate::peer_text::log_capture::captured_logs;

#[test]
fn a_ready_payload_yields_the_label_it_carries() {
    assert_eq!(ready_window_label("\"doc-3\""), Some("doc-3".to_string()));
    assert_eq!(ready_window_label("\"main\""), Some("main".to_string()));
}

#[test]
fn a_ready_payload_that_is_not_a_json_string_yields_nothing() {
    for payload in ["", "null", "42", "{\"label\":\"main\"}", "doc-3", "\"open"] {
        assert_eq!(ready_window_label(payload), None, "{payload:?}");
    }
}

#[test]
fn a_ready_label_cannot_forge_a_log_line_or_flood_the_log() {
    // JSON-encoded, as the event payload is: the decoded label holds a real
    // newline followed by a line in the app's own format.
    let forged = serde_json::to_string("doc-1\n[Tauri] window \"main\" destroy result: Ok(())")
        .expect("encode");
    let lines = captured_logs(|| {
        ready_window_label(&forged);
    });
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(!lines[0].contains('\n'), "{:?}", lines[0]);

    let huge = serde_json::to_string(&"d".repeat(1024 * 1024)).expect("encode");
    let lines = captured_logs(|| {
        ready_window_label(&huge);
    });
    assert!(
        lines[0].chars().count() < crate::peer_text::MAX_PEER_TEXT + 64,
        "{} characters reached the log",
        lines[0].chars().count()
    );
}

#[test]
fn intercepts_the_main_window() {
    assert!(intercepts_close("main"));
}

#[test]
fn intercepts_every_document_window() {
    for label in ["doc-1", "doc-42", "doc-abc"] {
        assert!(intercepts_close(label), "{label}");
    }
}

/// Settings and every other auxiliary window close normally — they hold no
/// document, so there is no save flow to run and nothing to park in a tray.
#[test]
fn lets_other_windows_close_normally() {
    for label in ["settings", "", "document", "doc", "main-2", "Doc-1"] {
        assert!(!intercepts_close(label), "{label:?}");
    }
}

/// Pinned against the one definition, so a future inline copy that drifts —
/// the shape this file used to have — fails here instead of silently.
#[test]
fn agrees_with_the_quit_definition() {
    for label in ["main", "doc-1", "settings", "", "doc", "main-2", "doc-"] {
        assert_eq!(
            intercepts_close(label),
            crate::quit::is_document_window_label(label),
            "{label:?}"
        );
    }
}
