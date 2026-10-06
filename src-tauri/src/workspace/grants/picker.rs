//! The folder pickers Rust shows for workspace access (WI-LX1.1).
//!
//! Purpose: how the user MAKES a grant. `pick_workspace_folder` shows the
//! picker and returns the choice (File → Open Workspace, Open Recent);
//! `request_workspace_confirmation` shows it at a folder and returns as soon as
//! it is up (the `open_workspace` MCP tool, which cannot hold a request open
//! for a person). Either way, what the user picks is granted and recorded by
//! `grant_chosen_root`; no script can name a folder and receive it.
//!
//! Key decisions:
//!   - Both are `async`: a dialog shown from a synchronous command would be
//!     driven from the IPC thread.
//!   - One dialog at a time, by an atomic slot (`begin_picker`), held until the
//!     answer is recorded — so a second dialog cannot open between the answer
//!     and the record.
//!   - A dialog that fails to LAUNCH is told apart from one that is up. The
//!     dialog plugin never reports "shown": it runs the panel from a closure
//!     on the main thread and calls back with the answer, discarding the
//!     result of scheduling that closure. So the request waits
//!     [`LAUNCH_GRACE`] for an early answer: a callback that is dropped (the
//!     closure never ran) or an answer before anyone could click (a platform
//!     with no working picker answers at once) is a launch failure; silence
//!     means the panel is up. That is inference, not a signal — a panel that
//!     hangs on its way up is indistinguishable from one on screen.
//!   - Only `show` touches the native panel, and it is the one untested line of
//!     glue: MockRuntime cannot show one, so it needs a running app (e2e).
//!     Everything else — the slot's whole lifecycle through each command, and
//!     every kind of answer — runs in `picker.test.rs` with the panel injected.
//!
//! @coordinates-with workspace/grants/mod.rs — the slot and `grant_chosen_root`
//! @coordinates-with services/workspaces/workspaceAccess.ts — the only caller
//! @module workspace/grants/picker

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::FilePath;
use tokio::sync::oneshot;

use super::{grant_chosen_root, PickerFlight, WorkspaceGrants};
use crate::command_error::{CommandError, ErrorCode};
use crate::localized_error;

/// How long a confirmation request waits to see whether the dialog failed to
/// launch. No person answers a folder dialog this fast.
const LAUNCH_GRACE: Duration = Duration::from_millis(300);

/// What the dialog answers: `None` is a cancel.
type Answer = Option<FilePath>;

/// Show the folder picker and grant + record what the user chooses. Returns the
/// canonical folder, or `None` when the dialog was cancelled.
///
/// `default_path` opens the dialog AT that folder, so confirming a requested
/// folder (Open Recent) is one click on Open.
#[tauri::command]
pub async fn pick_workspace_folder<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    default_path: Option<String>,
) -> Result<Option<String>, CommandError> {
    pick_with(&app, default_path, |start| show(&app, &window, start)).await
}

/// Show the folder picker AT `path` and return once it is up; the user's
/// answer is granted and recorded as [`pick_workspace_folder`] would.
/// Refused with `conflict` while another folder dialog is open, and with
/// `internal` when the dialog could not be shown.
#[tauri::command]
pub async fn request_workspace_confirmation<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    path: String,
) -> Result<(), CommandError> {
    confirm_with(
        &app,
        path,
        |start| show(&app, &window, Some(start)),
        LAUNCH_GRACE,
    )
    .await
}

/// [`pick_workspace_folder`] with the native panel injected.
async fn pick_with<R: Runtime>(
    app: &AppHandle<R>,
    default_path: Option<String>,
    show: impl FnOnce(Option<PathBuf>) -> oneshot::Receiver<Answer>,
) -> Result<Option<String>, CommandError> {
    let _flight = claim(app)?;
    let start = default_path.map(PathBuf::from).filter(|p| p.is_absolute());
    settle(app, show(start).await).await
}

/// [`request_workspace_confirmation`] with the native panel and the grace
/// period injected.
async fn confirm_with<R: Runtime>(
    app: &AppHandle<R>,
    path: String,
    show: impl FnOnce(PathBuf) -> oneshot::Receiver<Answer>,
    grace: Duration,
) -> Result<(), CommandError> {
    let start = PathBuf::from(&path);
    if !start.is_absolute() {
        return Err(CommandError::invalid_input(format!(
            "'{path}' is not absolute"
        )));
    }
    let flight = claim(app)?;
    let mut answered = show(start);
    match tokio::time::timeout(grace, &mut answered).await {
        // Silence: the panel is up. The user's answer is settled later, and
        // the slot is held until then.
        Err(_still_up) => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _flight: PickerFlight = flight;
                log_settled(&path, settle(&handle, answered.await).await);
            });
            Ok(())
        }
        // The callback was dropped: the closure that shows the panel never ran.
        Ok(Err(_dropped)) => Err(CommandError::internal(
            "the folder dialog could not be shown",
        )),
        // An answer before anyone could click: nothing was on screen to click.
        Ok(Ok(None)) => Err(CommandError::internal(
            "the folder dialog closed as soon as it opened; no folder picker is available here",
        )),
        // A folder that fast was not picked by a person, but it IS an answer
        // from the panel; settle it rather than discard it.
        Ok(Ok(Some(folder))) => {
            log_settled(&path, settle(app, Ok(Some(folder))).await);
            Ok(())
        }
    }
}

fn log_settled(path: &str, settled: Result<Option<String>, CommandError>) {
    match settled {
        Ok(Some(root)) => log::info!("[workspace-grants] Confirmed {root:?}"),
        Ok(None) => log::info!("[workspace-grants] Confirmation of {path:?} cancelled"),
        Err(e) => log::warn!(
            "[workspace-grants] Confirming {path:?} failed: {}",
            e.message()
        ),
    }
}

/// Take the one folder-dialog slot, or refuse.
fn claim<R: Runtime>(app: &AppHandle<R>) -> Result<PickerFlight, CommandError> {
    app.state::<WorkspaceGrants>()
        .begin_picker()
        .ok_or_else(|| localized_error!(ErrorCode::Conflict, "errors.workspaceAccess.pickerBusy"))
}

/// Put the native folder dialog on screen; its answer arrives on the receiver.
fn show<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::Window<R>,
    start: Option<PathBuf>,
) -> oneshot::Receiver<Answer> {
    use tauri_plugin_dialog::DialogExt;

    let title = if start.is_some() {
        rust_i18n::t!("workspaceAccess.confirmTitle")
    } else {
        rust_i18n::t!("workspaceAccess.pickTitle")
    };
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title.to_string())
        .set_can_create_directories(true);
    #[cfg(any(windows, target_os = "macos"))]
    {
        dialog = dialog.set_parent(window);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = window;
    if let Some(start) = start {
        dialog = dialog.set_directory(start);
    }
    let (answer, answered) = oneshot::channel();
    dialog.pick_folder(move |folder| {
        let _ = answer.send(folder);
    });
    answered
}

/// Everything after the dialog answers: `None` is a cancel; a folder is
/// granted and recorded, and its canonical root returned.
async fn settle<R: Runtime>(
    app: &AppHandle<R>,
    answer: Result<Answer, oneshot::error::RecvError>,
) -> Result<Option<String>, CommandError> {
    let Some(folder) =
        answer.map_err(|_| CommandError::internal("the folder dialog closed without an answer"))?
    else {
        return Ok(None);
    };
    let picked = folder
        .into_path()
        .map_err(|e| CommandError::invalid_input(format!("unusable folder: {e}")))?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || grant_chosen_root(&handle, &picked).map(Some))
        .await
        .map_err(|e| CommandError::internal(format!("workspace grant task failed: {e}")))?
}

#[cfg(test)]
#[path = "picker.test.rs"]
mod tests;
