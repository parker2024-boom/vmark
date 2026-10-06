//! What one workflow run carries from step to step (split from `runner.rs` at
//! the file-size limit).
//!
//! `RunContext` is everything a step is handed and that never changes while
//! the run lasts; `RunState` is what the steps before it have produced. The
//! four step phases take both, so none of them reaches for a loose variable
//! of the runner's.
//!
//! Key decisions:
//!   - Event emission failures are logged, not silently dropped; the terminal
//!     `workflow:complete` is retried once, because a panel that misses it
//!     waits forever.
//!   - A step counts as completed exactly when it has an entry in `outputs`:
//!     the one map is both what later steps read and what `needs:` is judged
//!     against, so the two cannot disagree.
//!   - Only the FIRST failure is remembered. Steps guarded by `failure()` or
//!     `always()` run after it, and one of those failing too is not the cause
//!     the run reports.
//!
//! @coordinates-with runner.rs — builds both and drives the phases
//! @coordinates-with condition_status.rs — `RunStatus`, derived per step
//! @module workflow::run_context

use crate::coherence::capture_policy::CapturePolicy;
use crate::workflow::approval::ApprovalRegistry;
use crate::workflow::condition::RunStatus;
use crate::workflow::expressions::WorkflowOutputs;
use crate::workflow::genie_step::ProviderConfig;
use crate::workflow::types::{RawDefaults, StepStatusEvent};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime};
use tokio_util::sync::CancellationToken;

/// Emit a Tauri event, logging failures instead of silently dropping them.
pub(super) fn emit_event<R: Runtime>(
    app: &AppHandle<R>,
    event: &str,
    data: impl serde::Serialize + Clone,
) {
    if let Err(e) = app.emit(event, data.clone()) {
        log::error!("Failed to emit {:?}: {}", event, e);
        if event == "workflow:complete" {
            if let Err(e2) = app.emit(event, data) {
                log::error!("Retry failed for {:?}: {}", event, e2);
            }
        }
    }
}

/// The fixed surroundings of one run.
pub(super) struct RunContext<'a, R: Runtime> {
    pub(super) app: &'a AppHandle<R>,
    pub(super) execution_id: &'a str,
    pub(super) workspace_root: &'a Path,
    /// The user's cancel, as the flag every step checks before it starts…
    pub(super) cancel_flag: &'a AtomicBool,
    /// …and as the token in-flight work and the approval wait react to.
    pub(super) cancel: CancellationToken,
    pub(super) provider: Option<ProviderConfig>,
    pub(super) genies_dir: Option<PathBuf>,
    pub(super) approvals: Arc<ApprovalRegistry>,
    pub(super) capture_policy: CapturePolicy,
    pub(super) defaults: RawDefaults,
    /// The workflow's `env:` merged with the caller's (the caller's wins).
    pub(super) env: HashMap<String, String>,
}

impl<R: Runtime> RunContext<'_, R> {
    pub(super) fn cancel_requested(&self) -> bool {
        self.cancel_flag.load(Ordering::SeqCst)
    }

    pub(super) fn running(&self, step_id: &str) {
        self.step_update(step_id, "running", None, None, None);
    }

    pub(super) fn skipped(&self, step_id: &str, why: Option<String>, duration: Option<u64>) {
        self.step_update(step_id, "skipped", None, why, duration);
    }

    pub(super) fn errored(&self, step_id: &str, error: String, duration: Option<u64>) {
        self.step_update(step_id, "error", None, Some(error), duration);
    }

    pub(super) fn succeeded(&self, step_id: &str, output: String, duration: u64) {
        self.step_update(step_id, "success", Some(output), None, Some(duration));
    }

    /// Tell the frontend about one step transition.
    fn step_update(
        &self,
        step_id: &str,
        status: &str,
        output: Option<String>,
        error: Option<String>,
        duration: Option<u64>,
    ) {
        emit_event(
            self.app,
            "workflow:step-update",
            StepStatusEvent {
                execution_id: self.execution_id.to_string(),
                step_id: step_id.to_string(),
                status: status.to_string(),
                output,
                error,
                duration,
            },
        );
    }
}

/// What the steps so far have produced.
#[derive(Default)]
pub(super) struct RunState {
    /// Structured outputs of every step that completed: step id → field →
    /// value. Action steps and text genies have the single field `text`; JSON
    /// genies have one per top-level field.
    pub(super) outputs: WorkflowOutputs,
    first_failure: Option<String>,
}

impl RunState {
    /// Record a failure under `label` — the step id, or the id with a reason.
    pub(super) fn fail(&mut self, label: impl Into<String>) {
        self.first_failure.get_or_insert_with(|| label.into());
    }

    pub(super) fn complete(&mut self, step_id: &str, outputs: HashMap<String, String>) {
        self.outputs.insert(step_id.to_string(), outputs);
    }

    /// The label of the first failure, if any step failed.
    pub(super) fn first_failure(&self) -> Option<&str> {
        self.first_failure.as_deref()
    }

    /// The run as a step with these `needs:` sees it.
    pub(super) fn status_for(&self, needs: &[String]) -> RunStatus {
        RunStatus {
            failed: self.first_failure.is_some(),
            blocked: needs.iter().any(|dep| !self.outputs.contains_key(dep)),
        }
    }
}
