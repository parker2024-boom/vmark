// WI-RA7C.5 — test support: invoke a command the way a webview does, through
// the IPC layer of a mock app, so a test can say WHICH window the call came
// from. A command that takes the caller's identity from `tauri::Window` sees
// the window the message arrived on; one that reads a label from its arguments
// sees whatever the page chose to write there. Only an IPC-level call can tell
// the two apart.

use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindow;

/// A mock app whose invoke handler is `handler` (from `tauri::generate_handler!`).
pub(crate) fn app_with<F>(handler: F) -> tauri::App<MockRuntime>
where
    F: Fn(tauri::ipc::Invoke<MockRuntime>) -> bool + Send + Sync + 'static,
{
    tauri::test::mock_builder()
        .invoke_handler(handler)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

/// Open a window labelled `label` on `app`.
pub(crate) fn window(app: &tauri::App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .unwrap_or_else(|e| panic!("open window {label}: {e}"))
}

/// Invoke `command` from `caller` with JSON `args`; the command's JSON answer,
/// or its error value.
pub(crate) fn invoke_from(
    caller: &WebviewWindow<MockRuntime>,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    let request = InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().expect("url"),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    tauri::test::get_ipc_response(caller, request).map(|body| {
        body.deserialize::<serde_json::Value>()
            .expect("json answer")
    })
}
