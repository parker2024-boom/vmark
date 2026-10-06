//! Step phase 2 — the approval gate (split from `runner.rs` at the file-size
//! limit).
//!
//! When a step's effective `approval` is `ask`, the runner announces the
//! request and parks until the dialog answers, the wait expires, or the user
//! cancels the run.
//!
//! Key decisions:
//!   - The receiver is registered BEFORE the request is announced, so an
//!     answer that arrives at once has somewhere to land.
//!   - The preview is built from the RESOLVED parameters, and for a genie
//!     step from its filled template: the user approves what the model will
//!     actually receive.
//!   - The wait is the shorter of the step's timeout and ten minutes.
//!   - A wait cut short by the user's cancel is a skipped step; a denial, a
//!     dropped dialog and an expired wait are failed ones.
//!
//! @coordinates-with runner.rs — calls this between preflight and execution
//! @coordinates-with approval.rs — the registry the dialog answers through
//! @module workflow::step_approval

use super::run_context::{emit_event, RunContext, RunState};
use super::step_execute::parse_genie_content;
use super::step_preflight::Ready;
use super::ResolvedStep;
use crate::workflow::approval::ApprovalRequest;
use crate::workflow::genie_step;
use crate::workflow::step_config::StepConfig;
use crate::workflow::types::RawStep;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tauri::Runtime;

/// The longest an approval dialog is waited on, whatever the step's timeout.
const APPROVAL_CEILING: Duration = Duration::from_secs(600);

/// Outcome of the approval wait — explicit so the caller doesn't have to
/// reason about which `Result` variant came from where.
enum ApprovalOutcome {
    Approved,
    Denied,
    /// Sender side dropped without delivering a value (window close, etc.).
    ChannelClosed,
    /// Approval window expired.
    TimedOut,
    /// Workflow was cancelled while the dialog was open.
    Cancelled,
}

/// Ask for approval if the step requires it. `true` means the step may run;
/// on `false` the frontend has been told why it did not.
pub(super) async fn approval_gate<R: Runtime>(
    ctx: &RunContext<'_, R>,
    state: &mut RunState,
    rs: &ResolvedStep,
    ready: &Ready,
    config: &StepConfig,
) -> bool {
    if config.approval != "ask" {
        return true;
    }

    let key = (ctx.execution_id.to_string(), rs.id.clone());
    let rx = ctx.approvals.register(key.clone());
    let preview = build_approval_preview(&rs.step, &ready.params, ctx.genies_dir.as_deref()).await;
    emit_event(
        ctx.app,
        "workflow:approval-request",
        ApprovalRequest {
            execution_id: ctx.execution_id.to_string(),
            step_id: rs.id.clone(),
            summary: rs.step.uses.clone(),
            preview,
            model: config.model.clone(),
        },
    );
    let wait = Duration::from_secs(config.timeout_secs).min(APPROVAL_CEILING);
    let outcome = tokio::select! {
        _ = ctx.cancel.cancelled() => ApprovalOutcome::Cancelled,
        res = tokio::time::timeout(wait, rx) => match res {
            Ok(Ok(true)) => ApprovalOutcome::Approved,
            Ok(Ok(false)) => ApprovalOutcome::Denied,
            Ok(Err(_)) => ApprovalOutcome::ChannelClosed,
            Err(_) => ApprovalOutcome::TimedOut,
        },
    };

    let waited = Some(ready.started.elapsed().as_millis() as u64);
    let refusal = match outcome {
        ApprovalOutcome::Approved => return true,
        ApprovalOutcome::Cancelled => {
            ctx.approvals.drop_pending(&key);
            state.fail(&rs.id);
            ctx.skipped(&rs.id, Some("Workflow cancelled".to_string()), waited);
            return false;
        }
        ApprovalOutcome::TimedOut => {
            ctx.approvals.drop_pending(&key);
            "Approval timed out"
        }
        ApprovalOutcome::ChannelClosed => "Approval channel closed",
        ApprovalOutcome::Denied => "Approval denied by user",
    };
    state.fail(&rs.id);
    ctx.errored(&rs.id, refusal.to_string(), waited);
    false
}

/// Build the preview the approval dialog shows.
///
/// For genie steps, attempts to load the genie and fill its template against
/// `resolved_params` so the preview matches what the model will actually
/// receive. Falls back to the raw `with.input` / `with.content` / `with.prompt`
/// value if the genie can't be loaded (so non-genie steps and authoring-time
/// errors still get a useful preview).
async fn build_approval_preview(
    step: &RawStep,
    resolved_params: &HashMap<String, String>,
    genies_dir: Option<&Path>,
) -> String {
    const PREVIEW_BYTES: usize = 500;

    if let Some(name) = step.uses.strip_prefix("genie/") {
        if let Some(dir) = genies_dir {
            if let Ok(path) = genie_step::find_genie_file(dir, name) {
                if let Ok(raw) = tokio::fs::read_to_string(&path).await {
                    if let Ok(content) = parse_genie_content(&raw, &path) {
                        if let Ok(filled) =
                            crate::workflow::template::fill(&content.template, resolved_params)
                        {
                            return filled.chars().take(PREVIEW_BYTES).collect();
                        }
                    }
                }
            }
        }
    }

    resolved_params
        .get("input")
        .or_else(|| resolved_params.get("content"))
        .or_else(|| resolved_params.get("prompt"))
        .map(|s| s.chars().take(PREVIEW_BYTES).collect())
        .unwrap_or_default()
}
