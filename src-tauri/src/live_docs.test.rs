//! Tests for the cross-window live-reference aggregation (WI-9).
//!
//! The window/emit half needs an AppHandle; these cover the state machinery —
//! which is where fail-closed either holds or does not. Answers are counted by
//! DISTINCT EXPECTED LABEL because `window.emit` broadcasts in Tauri v2: the
//! requester's own responder echoes every request, and without labels that
//! echo completed the count while the window that mattered stayed silent.

use super::*;
use std::collections::HashSet;

fn labels(names: &[&str]) -> HashSet<String> {
    names.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn zero_targets_is_complete_and_empty() {
    let rx = register_request("req-zero", labels(&[]));
    rx.await.expect("completed");
    let (complete, refs) = take_result("req-zero");
    assert!(complete);
    assert!(refs.is_empty());
}

#[tokio::test]
async fn all_labels_answering_completes_with_the_union() {
    let rx = register_request("req-two", labels(&["main", "doc-1"]));
    assert!(!apply_response("req-two", "main", vec!["a.png".into()]));
    assert!(apply_response(
        "req-two",
        "doc-1",
        vec!["b.png".into(), "c.png".into()]
    ));
    rx.await.expect("completed");
    let (complete, refs) = take_result("req-two");
    assert!(complete);
    assert_eq!(refs, vec!["a.png", "b.png", "c.png"]);
}

#[tokio::test]
async fn a_missing_label_reports_incomplete() {
    let _rx = register_request("req-partial", labels(&["main", "doc-1"]));
    apply_response("req-partial", "main", vec!["a.png".into()]);
    let (complete, refs) = take_result("req-partial");
    assert!(!complete, "one unanswered window must mean incomplete");
    // Partial refs still travel — they can only PROTECT more.
    assert_eq!(refs, vec!["a.png"]);
}

#[tokio::test]
async fn the_requesters_own_echo_does_not_count() {
    // THE broadcast bug: window.emit reaches every window, so the requester
    // answers its own request. That echo must not complete the collection.
    let _rx = register_request("req-echo", labels(&["doc-1"]));
    assert!(!apply_response(
        "req-echo",
        "main", // the REQUESTER — not in the expected set
        vec!["own.png".into()]
    ));
    let (complete, refs) = take_result("req-echo");
    assert!(!complete, "an unexpected label must not stand in for doc-1");
    assert!(refs.is_empty(), "unexpected answers contribute nothing");
}

#[tokio::test]
async fn a_duplicate_answer_from_one_window_counts_once() {
    // React Strict Mode can register two listeners in one window.
    let _rx = register_request("req-dup", labels(&["doc-1", "doc-2"]));
    assert!(!apply_response("req-dup", "doc-1", vec!["a.png".into()]));
    assert!(!apply_response("req-dup", "doc-1", vec!["a.png".into()]));
    let (complete, _) = take_result("req-dup");
    assert!(!complete, "doc-1 twice must not stand in for doc-2");
}

#[tokio::test]
async fn a_late_answer_after_take_is_ignored() {
    let _rx = register_request("req-late", labels(&["doc-1"]));
    let (complete, _) = take_result("req-late");
    assert!(!complete);
    assert!(!apply_response(
        "req-late",
        "doc-1",
        vec!["late.png".into()]
    ));
}

#[tokio::test]
async fn unknown_request_is_ignored() {
    assert!(!apply_response(
        "never-registered",
        "doc-1",
        vec!["x.png".into()]
    ));
    let (complete, refs) = take_result("never-registered");
    assert!(!complete);
    assert!(refs.is_empty());
}

// -- WI-RA7C.5: answers count for the window they came from ------------------

#[cfg(not(target_os = "windows"))]
mod caller_identity {
    use super::{register_request, take_result};
    use crate::ipc_caller::{app_with, invoke_from, window};
    use serde_json::json;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        app_with(tauri::generate_handler![
            super::super::live_docs_response,
            super::super::collect_live_document_refs,
        ])
    }

    /// A window that could answer FOR another, with no references, made the
    /// request read as complete — and an image the other window's unsaved
    /// buffer still uses was deleted.
    #[test]
    fn a_window_cannot_answer_for_another() {
        let app = app();
        let impostor = window(&app, "doc-1");
        let _silent = window(&app, "doc-2");
        let _rx = register_request("req-impostor", ["doc-2".to_string()].into_iter().collect());

        let answer = invoke_from(
            &impostor,
            "live_docs_response",
            json!({ "requestId": "req-impostor", "label": "doc-2", "refs": [] }),
        );

        assert!(answer.is_ok(), "{answer:?}");
        let (complete, _) = take_result("req-impostor");
        assert!(!complete, "doc-1 answered as doc-2");
    }

    #[test]
    fn a_window_answers_for_itself() {
        let app = app();
        let responder = window(&app, "doc-3");
        let _rx = register_request("req-honest", ["doc-3".to_string()].into_iter().collect());

        let answer = invoke_from(
            &responder,
            "live_docs_response",
            json!({ "requestId": "req-honest", "refs": ["a.png"] }),
        );

        assert!(answer.is_ok(), "{answer:?}");
        assert_eq!(take_result("req-honest"), (true, vec!["a.png".to_string()]));
    }

    /// The requester is never asked to answer its own request: it is the window
    /// the call came from, whatever label the page sent.
    #[test]
    fn the_requester_is_the_calling_window() {
        let app = app();
        let requester = window(&app, "doc-4");

        let answer = invoke_from(
            &requester,
            "collect_live_document_refs",
            json!({ "requestingLabel": "doc-elsewhere" }),
        )
        .expect("answered");

        // No other document window exists, so nobody is asked and the answer is
        // complete at once — not after waiting out the deadline for itself.
        assert_eq!(answer["complete"], json!(true), "{answer}");
    }
}
