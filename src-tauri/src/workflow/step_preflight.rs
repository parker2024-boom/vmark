//! Step phase 1 — preflight: may the step run, and with which parameters?
//! (split from `runner.rs` at the file-size limit)
//!
//! Pipeline: cancel check → `if:` decision → `running` event → parameter
//! resolution. Every way out that is not "run it" has told the frontend why
//! before it returns.
//!
//! Key decisions:
//!   - The cancel check comes first and is absolute: a cancelled run skips
//!     every remaining step, `always()` steps included.
//!   - The step's `if:` decides whether it runs, under the run so far
//!     (`success()` when it has none). Fail-loud: a condition that does not
//!     parse fails the step, never silently passes.
//!   - A `path` parameter is validated against the workspace AFTER
//!     substitution, so a value spliced in from a step output or the
//!     environment cannot point the step outside it.
//!
//! @coordinates-with runner.rs — calls this first for every step
//! @coordinates-with condition.rs — the `if:` evaluator
//! @coordinates-with expressions.rs — the parameter resolver
//! @module workflow::step_preflight

use super::run_context::{RunContext, RunState};
use super::ResolvedStep;
use crate::workflow::condition::evaluate_condition;
use crate::workflow::expressions::{self, WorkflowOutputs};
use crate::workflow::sandbox::validate_path;
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;
use tauri::Runtime;

/// A step that passed preflight.
pub(super) struct Ready {
    /// The step's `with:` map, every reference resolved.
    pub(super) params: HashMap<String, String>,
    /// When the step was announced as `running`; durations count from here.
    pub(super) started: Instant,
}

/// Decide whether `rs` runs. `None` means it does not, and the frontend has
/// been told: `skipped` (cancelled, or its condition is not met) or `error`
/// (the condition or a parameter could not be resolved).
pub(super) fn step_preflight<R: Runtime>(
    ctx: &RunContext<'_, R>,
    state: &mut RunState,
    rs: &ResolvedStep,
) -> Option<Ready> {
    if ctx.cancel_requested() {
        ctx.skipped(&rs.id, Some("Workflow cancelled".to_string()), None);
        state.fail(format!("{} (cancelled)", rs.id));
        return None;
    }

    let status = state.status_for(&rs.needs);
    let runs = match &rs.step.condition {
        Some(condition) => evaluate_condition(condition, &state.outputs, &ctx.env, status),
        None => Ok(status.succeeded()),
    };
    match runs {
        Ok(true) => {}
        Ok(false) => {
            let unmet = rs.step.condition.as_ref();
            let why = unmet.map(|condition| format!("Condition not met: {}", condition));
            ctx.skipped(&rs.id, why, None);
            return None;
        }
        Err(e) => {
            state.fail(&rs.id);
            ctx.errored(&rs.id, format!("Condition evaluation failed: {}", e), None);
            return None;
        }
    }

    ctx.running(&rs.id);
    let started = Instant::now();
    match resolve_params(&rs.step.with, &state.outputs, &ctx.env, ctx.workspace_root) {
        Ok(params) => Some(Ready { params, started }),
        Err(e) => {
            state.fail(&rs.id);
            ctx.errored(
                &rs.id,
                format!("Parameter resolution failed: {}", e),
                Some(started.elapsed().as_millis() as u64),
            );
            None
        }
    }
}

/// Resolve step parameters via the expression module.
///
/// Supports `${{ steps.X.outputs.Y }}`, `${{ steps.X.output }}`,
/// `${{ env.NAME }}`, legacy `${VAR}`, and legacy whole-string
/// `stepId.output` aliases.
fn resolve_params(
    params: &HashMap<String, String>,
    outputs: &WorkflowOutputs,
    env: &HashMap<String, String>,
    workspace_root: &Path,
) -> Result<HashMap<String, String>, String> {
    let mut resolved = HashMap::new();

    for (key, value) in params {
        let val = expressions::resolve(value, outputs, env).map_err(|e| e.to_string())?;

        // Re-validate paths after substitution.
        if key == "path" {
            validate_path(&val, workspace_root)
                .map_err(|e| format!("Path validation failed after parameter resolution: {}", e))?;
        }

        resolved.insert(key.clone(), val);
    }

    Ok(resolved)
}

#[cfg(test)]
#[path = "step_preflight.test.rs"]
mod tests;
