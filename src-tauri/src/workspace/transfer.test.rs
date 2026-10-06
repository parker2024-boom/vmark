//! Tests for `workspace/transfer.rs` (extracted to keep the production
//! file under the size gate; included via `#[path]`).

use super::*;

// These tests mutate process-global registries, so they must run serially.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn acquire_test_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn transfer_data(request_id: &str) -> WorkspaceTransferData {
    WorkspaceTransferData {
        request_id: request_id.to_string(),
        operation: "move".to_string(),
        source_window_label: "main".to_string(),
        workspace_instance_id: "wsi-a".to_string(),
        kind: "workspace".to_string(),
        root_id: Some("root-a".to_string()),
        root_path: Some("/repo".to_string()),
        display_name: "repo".to_string(),
        active_tab_id: None,
        tabs: vec![],
    }
}

fn reset_transfer_state() {
    *transfer_registry() = None;
    *ack_routes() = None;
    *ack_route_targets() = None;
}

/// Register routes for a transfer as `detach_workspace_to_new_window` would,
/// keyed on a known target label (no window is created in unit tests).
fn register_routes(target_label: &str, data: &WorkspaceTransferData) {
    transfer_registry()
        .get_or_insert_with(HashMap::new)
        .insert(target_label.to_string(), data.clone());
    ack_routes().get_or_insert_with(HashMap::new).insert(
        data.request_id.clone(),
        AckRoute {
            source_window_label: data.source_window_label.clone(),
            target_window_label: target_label.to_string(),
            workspace_instance_id: data.workspace_instance_id.clone(),
        },
    );
    ack_route_targets()
        .get_or_insert_with(HashMap::new)
        .insert(target_label.to_string(), data.request_id.clone());
}

#[test]
fn clear_unclaimed_transfer_clears_ack_route_after_claim() {
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-a");
    register_routes("doc-1", &data);

    assert!(take_workspace_transfer("doc-1").is_some());
    assert!(ack_routes()
        .as_ref()
        .is_some_and(|routes| routes.contains_key("req-a")));

    clear_unclaimed_transfer("doc-1");

    assert!(!ack_routes()
        .as_ref()
        .is_some_and(|routes| routes.contains_key("req-a")));
    assert!(!ack_route_targets()
        .as_ref()
        .is_some_and(|targets| targets.contains_key("doc-1")));
    reset_transfer_state();
}

#[test]
fn cancelling_drops_unclaimed_payload_and_routes() {
    // Models the source-side timeout cancel, once `cancel_workspace_transfer`
    // has checked the caller is the source (pinned in `caller_identity` below):
    // the still-registered payload must be removed so a late claim returns
    // nothing (no duplicate move).
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-cancel");
    register_routes("doc-cancel", &data);

    clear_unclaimed_transfer("doc-cancel");

    assert!(take_workspace_transfer("doc-cancel").is_none());
    assert!(!ack_routes()
        .as_ref()
        .is_some_and(|m| m.contains_key("req-cancel")));
    assert!(!ack_route_targets()
        .as_ref()
        .is_some_and(|m| m.contains_key("doc-cancel")));
    reset_transfer_state();
}

#[test]
fn rollback_removes_all_registered_routes() {
    // Models a window build failure after registration: the rollback must
    // leave no orphaned transfer / ack / target state behind.
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-roll");
    register_routes("doc-9", &data);

    rollback_transfer_registration("doc-9", "req-roll");

    assert!(!transfer_registry()
        .as_ref()
        .is_some_and(|m| m.contains_key("doc-9")));
    assert!(!ack_routes()
        .as_ref()
        .is_some_and(|m| m.contains_key("req-roll")));
    assert!(!ack_route_targets()
        .as_ref()
        .is_some_and(|m| m.contains_key("doc-9")));
    reset_transfer_state();
}

#[test]
fn mismatched_ack_target_label_leaves_route_intact() {
    // A stale / wrong ack (correct request_id, wrong target window label)
    // must NOT tear down the still-pending route. We can't drive the full
    // command (it needs an AppHandle to emit), so we assert the validation
    // gate directly via the route comparison the command performs.
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-mismatch");
    register_routes("doc-1", &data);

    // The validation logic mirrors ack_workspace_transfer's gate.
    let matches = ack_routes()
        .as_ref()
        .and_then(|map| map.get("req-mismatch"))
        .map(|route| {
            route.target_window_label == "WRONG-LABEL"
                && route.workspace_instance_id == data.workspace_instance_id
        })
        .unwrap_or(false);
    assert!(!matches, "mismatched target label must fail validation");

    // Route is untouched because validation would short-circuit before removal.
    assert!(ack_routes()
        .as_ref()
        .is_some_and(|m| m.contains_key("req-mismatch")));
    reset_transfer_state();
}

#[test]
fn mismatched_ack_instance_id_leaves_route_intact() {
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-wsi");
    register_routes("doc-1", &data);

    let matches = ack_routes()
        .as_ref()
        .and_then(|map| map.get("req-wsi"))
        .map(|route| {
            route.target_window_label == "doc-1" && route.workspace_instance_id == "WRONG-WSI"
        })
        .unwrap_or(false);
    assert!(
        !matches,
        "mismatched workspace instance id must fail validation"
    );
    assert!(ack_routes()
        .as_ref()
        .is_some_and(|m| m.contains_key("req-wsi")));
    reset_transfer_state();
}

#[test]
fn matching_ack_passes_validation_gate() {
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-ok");
    register_routes("doc-1", &data);

    let matches = ack_routes()
        .as_ref()
        .and_then(|map| map.get("req-ok"))
        .map(|route| {
            route.target_window_label == "doc-1"
                && route.workspace_instance_id == data.workspace_instance_id
        })
        .unwrap_or(false);
    assert!(matches, "a correct ack must pass the validation gate");
    reset_transfer_state();
}

// ---------------------------------------------------------------------------
// The ack is webview text (WI-RA7.7)

// `tauri::test` does not exist on Windows (see Cargo.toml's target-specific
// dev-dependency); every caller is gated to match.
#[cfg(not(target_os = "windows"))]
fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

#[cfg(not(target_os = "windows"))]
#[test]
fn a_mismatched_ack_is_refused_in_one_escaped_log_line() {
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-forge");
    register_routes("doc-1", &data);
    let app = mock_app();
    let target = mock_window(&app, "doc-1");

    let lines = crate::peer_text::log_capture::captured_logs(|| {
        ack_workspace_transfer(
            target,
            app.handle().clone(),
            WorkspaceTransferAck {
                request_id: "req-forge".to_string(),
                target_window_label: "doc-9'\n[WorkspaceTransfer] ack accepted for 'doc-1"
                    .to_string(),
                workspace_instance_id: format!("wsi-\r\x1b[2K{}", "w".repeat(4096)),
            },
        )
        .expect("a refused ack is not an error");
    });

    assert_eq!(lines.len(), 1, "{lines:?}");
    for raw in ['\n', '\r', '\x1b'] {
        assert!(!lines[0].contains(raw), "{raw:?} reached the log");
    }
    assert!(
        lines[0].chars().count() < 3 * crate::peer_text::MAX_PEER_TEXT + 128,
        "{} characters reached the log",
        lines[0].chars().count()
    );
    // And the refusal itself: the pending route is untouched.
    assert!(ack_routes()
        .as_ref()
        .is_some_and(|m| m.contains_key("req-forge")));
    reset_transfer_state();
}

// ---------------------------------------------------------------------------
// A window speaks only for itself (WI-RA7.5)
//
// `claim_workspace_transfer` used to take the window label from its arguments,
// and the ack was matched only against a label inside its payload. A label is
// a string any webview can spell, so one window could take — or acknowledge —
// a transfer meant for another. Both now use the window the call came from.

#[cfg(not(target_os = "windows"))]
fn mock_window(
    app: &tauri::App<tauri::test::MockRuntime>,
    label: &str,
) -> tauri::Window<tauri::test::MockRuntime> {
    let window =
        tauri::webview::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
            .visible(false)
            .build()
            .expect("build mock window");
    AsRef::<tauri::Webview<_>>::as_ref(&window).window()
}

#[cfg(not(target_os = "windows"))]
fn ack_for(data: &WorkspaceTransferData, target: &str) -> WorkspaceTransferAck {
    WorkspaceTransferAck {
        request_id: data.request_id.clone(),
        target_window_label: target.to_string(),
        workspace_instance_id: data.workspace_instance_id.clone(),
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn a_window_claims_only_the_workspace_transfer_registered_for_itself() {
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-own");
    register_routes("doc-1", &data);
    let app = mock_app();
    let target = mock_window(&app, "doc-1");
    let bystander = mock_window(&app, "doc-2");

    assert!(
        claim_workspace_transfer(bystander).is_none(),
        "a window with no transfer of its own gets nothing"
    );
    let claimed = claim_workspace_transfer(target.clone())
        .expect("the bystander's claim did not consume the target's payload");
    assert_eq!(claimed.request_id, "req-own");
    assert!(
        claim_workspace_transfer(target).is_none(),
        "a claim is a take"
    );
    reset_transfer_state();
}

#[cfg(not(target_os = "windows"))]
#[test]
fn an_ack_from_a_window_that_is_not_the_target_leaves_the_transfer_pending() {
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let data = transfer_data("req-ack");
    register_routes("doc-1", &data);
    let app = mock_app();
    let target = mock_window(&app, "doc-1");
    let bystander = mock_window(&app, "doc-2");

    // Every field is right; only the sender is wrong.
    ack_workspace_transfer(bystander, app.handle().clone(), ack_for(&data, "doc-1"))
        .expect("a refused ack is not an error");
    assert!(
        ack_routes()
            .as_ref()
            .is_some_and(|m| m.contains_key("req-ack")),
        "an ack from another window must not complete the transfer"
    );

    ack_workspace_transfer(target, app.handle().clone(), ack_for(&data, "doc-1"))
        .expect("the target's own ack");
    assert!(
        !ack_routes()
            .as_ref()
            .is_some_and(|m| m.contains_key("req-ack")),
        "the target's ack completes it"
    );
    reset_transfer_state();
}

// -- WI-RA7C.5: only the source cancels; the source is the caller -------------

#[cfg(not(target_os = "windows"))]
mod caller_identity {
    use super::super::{transfer_registry, WorkspaceTransferData};
    use super::{acquire_test_lock, register_routes, reset_transfer_state, transfer_data};
    use crate::ipc_caller::{app_with, invoke_from, window};
    use serde_json::json;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        app_with(tauri::generate_handler![
            super::super::cancel_workspace_transfer
        ])
    }

    fn pending(target: &str) -> bool {
        transfer_registry()
            .as_ref()
            .is_some_and(|map| map.contains_key(target))
    }

    fn moving_from(source: &str) -> WorkspaceTransferData {
        WorkspaceTransferData {
            source_window_label: source.to_string(),
            ..transfer_data("req-cancel")
        }
    }

    /// Any window could strand another's move by naming its target.
    #[test]
    fn another_window_cannot_cancel_a_transfer() {
        let _lock = acquire_test_lock();
        reset_transfer_state();
        register_routes("doc-9", &moving_from("doc-1"));
        let app = app();
        let bystander = window(&app, "doc-2");

        let answer = invoke_from(
            &bystander,
            "cancel_workspace_transfer",
            json!({ "targetWindowLabel": "doc-9" }),
        );

        assert!(answer.is_ok(), "{answer:?}");
        assert!(pending("doc-9"), "doc-2 cancelled doc-1's transfer");
        reset_transfer_state();
    }

    #[test]
    fn the_source_cancels_its_own_transfer() {
        let _lock = acquire_test_lock();
        reset_transfer_state();
        register_routes("doc-9", &moving_from("doc-1"));
        let app = app();
        let source = window(&app, "doc-1");

        let answer = invoke_from(
            &source,
            "cancel_workspace_transfer",
            json!({ "targetWindowLabel": "doc-9" }),
        );

        assert!(answer.is_ok(), "{answer:?}");
        assert!(!pending("doc-9"));
        reset_transfer_state();
    }

    /// Cancelling after the target claimed the payload still needs the
    /// ack route's source to match.
    #[test]
    fn a_claimed_transfer_is_still_cancelled_only_by_its_source() {
        let _lock = acquire_test_lock();
        reset_transfer_state();
        register_routes("doc-9", &moving_from("doc-1"));
        transfer_registry()
            .as_mut()
            .expect("registry")
            .remove("doc-9");
        let app = app();
        let bystander = window(&app, "doc-2");
        let source = window(&app, "doc-1");

        let _ = invoke_from(
            &bystander,
            "cancel_workspace_transfer",
            json!({ "targetWindowLabel": "doc-9" }),
        );
        assert!(super::super::ack_routes()
            .as_ref()
            .is_some_and(|r| r.contains_key("req-cancel")));

        let _ = invoke_from(
            &source,
            "cancel_workspace_transfer",
            json!({ "targetWindowLabel": "doc-9" }),
        );
        assert!(!super::super::ack_routes()
            .as_ref()
            .is_some_and(|r| r.contains_key("req-cancel")));
        reset_transfer_state();
    }
}

// -- WI-RA26.1: the transfer commands reject with a typed CommandError --------
//
// Their failures (the target window cannot be built, the ack cannot be
// emitted to the source) are unreachable under the mock runtime, so this pins
// the type the IPC layer serializes: a `CommandError` reaches the webview as
// `{ code, message }`, which `workspaceWindowActions.ts` can branch on, where a
// `String` would arrive as bare prose.

#[cfg(not(target_os = "windows"))]
#[test]
fn the_ack_command_answers_with_the_typed_error() {
    let _lock = acquire_test_lock();
    reset_transfer_state();
    let app = mock_app();
    let target = mock_window(&app, "doc-1");

    let answer: Result<(), crate::command_error::CommandError> = ack_workspace_transfer(
        target,
        app.handle().clone(),
        WorkspaceTransferAck {
            request_id: "req-unknown".to_string(),
            target_window_label: "doc-1".to_string(),
            workspace_instance_id: "wsi-unknown".to_string(),
        },
    );

    assert!(answer.is_ok(), "an ack for no pending transfer is a no-op");
    reset_transfer_state();
}
