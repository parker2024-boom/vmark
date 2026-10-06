//! # Answering the OS exit request
//!
//! Purpose: decide what to do with Tauri's process-level exit request — let
//! the process go, or prevent it and either start the coordinated quit or
//! keep the app alive with no window. Pure, so the platform rule is testable
//! without an app.
//!
//! Key decisions:
//!   - macOS keeps the app alive when the last window closes, so the Dock icon
//!     can reopen a document window; Linux and Windows exit when no document
//!     window remains, as desktop and CLI-launched apps do there.
//!
//! @coordinates-with app_setup.rs — `handle_exit_requested` acts on the decision
//! @coordinates-with quit.rs — `start_quit`, the coordinated quit it may start
//! @module quit::exit_request

/// What to do with a process-level exit request.
#[derive(Debug, PartialEq)]
pub enum ExitRequestAction {
    AllowExit,
    PreventAndStartQuit,
    PreventAndKeepAlive,
}

/// Decide how to handle Tauri's process-level exit request.
pub fn decide_exit_request_action(
    exit_allowed: bool,
    has_document_windows: bool,
    keep_alive_without_documents: bool,
) -> ExitRequestAction {
    if exit_allowed {
        return ExitRequestAction::AllowExit;
    }
    if has_document_windows {
        return ExitRequestAction::PreventAndStartQuit;
    }
    if keep_alive_without_documents {
        ExitRequestAction::PreventAndKeepAlive
    } else {
        ExitRequestAction::AllowExit
    }
}

/// Whether this platform keeps the app running with no document window.
pub fn keep_alive_without_document_windows() -> bool {
    cfg!(target_os = "macos")
}
