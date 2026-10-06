// WI-RA14B.3 — the App Nap wake-and-retry: after a first timeout the SAME
// request id is re-sent to the target window on a fresh response channel,
// and every way the retry can end answers the client exactly once — with the
// response, or with an error naming why — and leaves no pending entry behind.

use super::super::managed::{bridge, McpBridgeState};
use super::super::types::{McpRequestEvent, McpResponse};
use super::wake_retry_after_timeout;
use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::Listener;
use tokio::sync::mpsc;

const TARGET: &str = "main";

fn mock_app(with_window: bool) -> tauri::App<MockRuntime> {
    let app = tauri::test::mock_builder()
        .manage(McpBridgeState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app");
    if with_window {
        tauri::webview::WebviewWindowBuilder::new(&app, TARGET, tauri::WebviewUrl::default())
            .visible(false)
            .build()
            .expect("mock window");
    }
    app
}

fn request(id: &str) -> McpRequestEvent {
    McpRequestEvent {
        id: id.to_string(),
        request_type: "document.read".to_string(),
        args_json: "{}".to_string(),
    }
}

/// Re-emitted requests, as JSON payloads, in arrival order.
fn re_emits(app: &tauri::App<MockRuntime>) -> mpsc::UnboundedReceiver<Value> {
    let (tx, rx) = mpsc::unbounded_channel();
    app.listen_any("mcp-bridge:request", move |event| {
        let _ = tx.send(serde_json::from_str(event.payload()).expect("json payload"));
    });
    rx
}

/// Run the retry for request `id` on a task of its own, so the test can play
/// the webview meanwhile.
fn spawn_retry(
    app: &tauri::App<MockRuntime>,
    id: &'static str,
) -> (
    tokio::task::JoinHandle<Option<McpResponse>>,
    mpsc::Receiver<String>,
) {
    let (client_tx, client_rx) = mpsc::channel(8);
    let handle = app.handle().clone();
    let task = tokio::spawn(async move {
        wake_retry_after_timeout(
            &handle,
            TARGET,
            &request(id),
            id,
            1,
            &client_tx,
            "msg-1",
            "document.read",
        )
        .await
    });
    (task, client_rx)
}

/// The error the client was sent, from the one message it received.
fn client_error(client_rx: &mut mpsc::Receiver<String>) -> String {
    let message: Value =
        serde_json::from_str(&client_rx.try_recv().expect("one message")).expect("json");
    assert_eq!(message["id"], json!("msg-1"));
    assert!(client_rx.try_recv().is_err(), "answered exactly once");
    message["payload"]["error"]
        .as_str()
        .expect("an error")
        .to_string()
}

async fn has_pending(app: &tauri::App<MockRuntime>, id: &str) -> bool {
    bridge(app.handle()).lock().await.pending.contains_key(id)
}

#[tokio::test]
async fn the_same_request_is_re_sent_and_its_late_response_is_returned() {
    let app = mock_app(true);
    let mut emitted = re_emits(&app);
    let (task, mut client_rx) = spawn_retry(&app, "req-ok");

    let resent = emitted.recv().await.expect("re-emitted");
    assert_eq!(
        resent["id"],
        json!("req-ok"),
        "the SAME id, so it is deduplicated"
    );
    // The webview answers through the channel the retry installed.
    let pending = bridge(app.handle())
        .lock()
        .await
        .pending
        .remove("req-ok")
        .expect("the retry registered a fresh channel");
    let answer = McpResponse {
        success: true,
        data: Some(json!({ "text": "late but fine" })),
        error: None,
    };
    pending.response_tx.send(answer).expect("retry is waiting");

    let response = task.await.expect("task").expect("the response");
    assert!(response.success);
    assert_eq!(response.data, Some(json!({ "text": "late but fine" })));
    assert!(
        client_rx.try_recv().is_err(),
        "the caller replies, not the retry"
    );
    assert!(
        !bridge(app.handle()).is_webview_alive(),
        "marked asleep until it answers"
    );
}

#[tokio::test]
async fn a_closed_target_window_fails_the_request_without_re_sending() {
    let app = mock_app(false);
    let mut emitted = re_emits(&app);
    let (task, mut client_rx) = spawn_retry(&app, "req-gone");

    assert!(task.await.expect("task").is_none());

    assert!(client_error(&mut client_rx).contains("was closed during retry"));
    assert!(!has_pending(&app, "req-gone").await);
    assert!(emitted.try_recv().is_err(), "nothing re-sent");
}

#[tokio::test]
async fn a_dropped_retry_channel_fails_the_request() {
    let app = mock_app(true);
    let mut emitted = re_emits(&app);
    let (task, mut client_rx) = spawn_retry(&app, "req-dropped");

    emitted.recv().await.expect("re-emitted");
    drop(
        bridge(app.handle())
            .lock()
            .await
            .pending
            .remove("req-dropped"),
    );

    assert!(task.await.expect("task").is_none());
    assert_eq!(
        client_error(&mut client_rx),
        "Response channel closed on retry"
    );
}

#[tokio::test(start_paused = true)]
async fn no_answer_to_the_retry_either_is_a_timeout_error() {
    let app = mock_app(true);
    let mut emitted = re_emits(&app);
    let (task, mut client_rx) = spawn_retry(&app, "req-silent");

    emitted.recv().await.expect("re-emitted");
    // The clock is paused: the runtime advances it to the timeout once every
    // task is idle, so this waits no real time.
    assert!(task.await.expect("task").is_none());

    let error = client_error(&mut client_rx);
    assert!(error.starts_with("Request timeout after 20s"), "{error}");
    assert!(!has_pending(&app, "req-silent").await);
}
