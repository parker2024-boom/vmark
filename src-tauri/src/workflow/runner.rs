//! Workflow runner with topological ordering and cancellation.
//!
//! Executes workflow steps respecting `needs:` dependencies via topological
//! sort (`step_order`). Steps without unmet dependencies run in declaration
//! order.
//!
//! Pipeline, per step — one module each, split out at the file-size limit:
//!   `step_preflight` (cancel, `if:`, parameters) → `step_approval`
//!   (`approval: ask`) → `step_execute` (the step, under its timeout) →
//!   `step_record` (outputs, events). `run_context` is what they share.
//!
//! Key decisions:
//!   - Exactly one `workflow:complete` on every path this function returns
//!     from, emitted in one place; `launch.rs` covers the paths that never
//!     return (a panic, the runtime dropping the task)
//!   - Returns Err when any step fails (not Ok with silent failure), naming
//!     the first step that failed
//!   - A step's `if:` decides whether it runs (`success()` when absent), so
//!     `failure()` / `always()` steps run after a failure; the run still fails
//!   - Cancellation checked before each step via shared AtomicBool, and before
//!     its condition: a cancel stops `always()` steps too
//!   - The cancel bridge lives exactly as long as the run: the run cancels its
//!     own token when it ends, and the bridge ends on that
//!   - Steps ordered by topological sort on `needs:` dependencies
//!
//! @coordinates-with launch.rs — spawns the run and guards its terminal event
//! @coordinates-with validate.rs — runs `topological_sort` at admission
//! @module workflow::runner

use super::approval::ApprovalRegistry;
use super::coherence_capture::StepSlice;
use super::genie_step::ProviderConfig;
use super::step_config::resolve_step_config;
use super::types::{ExecutionCompleteEvent, RawWorkflow};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tokio_util::sync::CancellationToken;

#[path = "run_context.rs"]
mod run_context;
#[path = "step_approval.rs"]
mod step_approval;
#[path = "step_execute.rs"]
mod step_execute;
#[path = "step_order.rs"]
mod step_order;
#[path = "step_preflight.rs"]
mod step_preflight;
#[path = "step_record.rs"]
mod step_record;

use run_context::{emit_event, RunContext, RunState};
use step_approval::approval_gate;
use step_execute::execute_with_timeout;
pub(super) use step_order::{topological_sort, ResolvedStep};
use step_preflight::step_preflight;
use step_record::record_step_result;

/// How often the bridge looks at the cancel flag.
const CANCEL_POLL: Duration = Duration::from_millis(100);

/// Convert the `Arc<AtomicBool>` cancel flag into a polling task that flips a
/// `CancellationToken`, the primitive the AI provider stack and the approval
/// wait react to.
///
/// The task ends when it has cancelled the token, or as soon as anyone else
/// has: the run cancels its token on the way out, so no bridge outlives its
/// run.
///
/// Wrapped in `spawn_logged` so a panic inside the polling loop surfaces in
/// the log instead of silently leaking a cancel token (which would let the
/// downstream AI request run past its caller's cancel signal).
fn spawn_cancel_bridge(
    flag: Arc<AtomicBool>,
    token: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    crate::task::spawn_logged("workflow-cancel-bridge", async move {
        loop {
            if flag.load(Ordering::SeqCst) {
                token.cancel();
                return;
            }
            tokio::select! {
                _ = token.cancelled() => return,
                _ = tokio::time::sleep(CANCEL_POLL) => {}
            }
        }
    })
}

/// Execute a parsed workflow with topological ordering and cancellation support.
///
/// The caller (commands.rs) provides `execution_id`, so events carry it from
/// the start, and `capture_policy`, which every save-file capture applies.
///
/// `provider` and `genies_dir` are required for `genie/*` steps; `None`
/// values cause genie steps to fail with a clear error rather than panic
/// (lets the runner exercise action-only workflows from contexts where no
/// AI provider has been selected yet).
#[allow(clippy::too_many_arguments)]
pub async fn run_workflow_sequential<R: Runtime>(
    app: &AppHandle<R>,
    workflow: RawWorkflow,
    env: HashMap<String, String>,
    workspace_root: &Path,
    execution_id: &str,
    cancel_token: &Arc<AtomicBool>,
    provider: Option<ProviderConfig>,
    genies_dir: Option<PathBuf>,
    approvals: Arc<ApprovalRegistry>,
    capture_policy: crate::coherence::capture_policy::CapturePolicy,
) -> Result<String, String> {
    // Bridge the cancel flag into a CancellationToken that the AI provider
    // stack and the approval wait can react to without polling. The guard
    // cancels the token when this run is over — on a return, a panic, or the
    // runtime dropping the task — which is what ends the bridge with it.
    let cancel = CancellationToken::new();
    let _bridge = spawn_cancel_bridge(Arc::clone(cancel_token), cancel.clone());
    let _run_over = cancel.clone().drop_guard();

    // Merge workflow env with provided env (provided takes precedence)
    let mut merged_env = workflow.env;
    merged_env.extend(env);
    let ctx = RunContext {
        app,
        execution_id,
        workspace_root,
        cancel_flag: cancel_token.as_ref(),
        cancel,
        provider,
        genies_dir,
        approvals,
        capture_policy,
        defaults: workflow.defaults,
        env: merged_env,
    };

    // Sort the steps by their `needs:` edges. `run_workflow` sorts the same
    // steps at admission, so this does not fail for a run it spawned; if it
    // ever does, the run ends like any other failed run — through the
    // completion event below — instead of returning without a word.
    let outcome = match topological_sort(workflow.steps) {
        Ok(sorted_steps) => run_steps(&ctx, &workflow.name, sorted_steps).await,
        Err(unsortable) => Err(unsortable),
    };

    // The one place a run that returns says so: nothing above returns.
    let final_status = if ctx.cancel_requested() {
        "cancelled"
    } else if outcome.is_err() {
        "failed"
    } else {
        "completed"
    };
    emit_event(
        app,
        "workflow:complete",
        ExecutionCompleteEvent {
            execution_id: execution_id.to_string(),
            status: final_status.to_string(),
        },
    );
    log::info!("Workflow {:?} {}", workflow.name, final_status);

    outcome.map(|()| execution_id.to_string())
}

/// Run the sorted steps in order, each through its four phases. `Err` names
/// the first step that failed.
async fn run_steps<R: Runtime>(
    ctx: &RunContext<'_, R>,
    name: &str,
    steps: Vec<ResolvedStep>,
) -> Result<(), String> {
    let step_count = steps.len();
    // Coherence: the steps as written, for tracing what fed a save-file.
    let dataflow: Vec<StepSlice> = steps
        .iter()
        .map(|rs| (rs.id.clone(), rs.step.uses.clone(), rs.step.with.clone()))
        .collect();
    let mut state = RunState::default();

    log::info!("Workflow {:?} starting: {} steps", name, step_count);

    for (i, rs) in steps.iter().enumerate() {
        let Some(ready) = step_preflight(ctx, &mut state, rs) else {
            continue;
        };
        // Effective approval mode and timeout for the step (ADR-6).
        let config = resolve_step_config(&rs.step, None, &ctx.defaults);
        if !approval_gate(ctx, &mut state, rs, &ready, &config).await {
            continue;
        }
        let result = execute_with_timeout(ctx, &rs.step, &ready.params, &config).await;
        let duration_ms = ready.started.elapsed().as_millis() as u64;
        let step_ok = result.is_ok();
        record_step_result(
            ctx,
            &mut state,
            &dataflow,
            rs,
            &ready.params,
            result,
            duration_ms,
        )
        .await;

        log::info!(
            "Workflow {:?}: step {}/{} ({}) ({}ms)",
            name,
            i + 1,
            step_count,
            if step_ok { "ok" } else { "FAILED" },
            duration_ms
        );
    }

    match state.first_failure() {
        Some(step) => Err(format!("Workflow '{}' failed at step '{}'", name, step)),
        None => Ok(()),
    }
}

#[cfg(test)]
#[path = "runner.test.rs"]
mod tests;

#[cfg(test)]
#[path = "runner_flow.test.rs"]
mod flow_tests;
