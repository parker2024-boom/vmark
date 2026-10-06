//! Step phase 4 — recording the result (split from `runner.rs` at the
//! file-size limit).
//!
//! A step that returned is turned into run state and into the event the
//! frontend sees: its outputs become readable by later steps, or the run is
//! marked failed.
//!
//! Key decisions:
//!   - A successful `action/save-file` is offered to Coherence BEFORE the
//!     success event, awaited, so a capture is never still in flight when the
//!     panel is told the step is done.
//!   - Later steps read the FULL output; only the copy sent over IPC is
//!     truncated, on a UTF-8 character boundary.
//!
//! @coordinates-with runner.rs — calls this last for every step that ran
//! @coordinates-with coherence_capture.rs — records the save and its inputs
//! @module workflow::step_record

use super::run_context::{RunContext, RunState};
use super::ResolvedStep;
use crate::workflow::coherence_capture::{capture_save_file_ordered, StepSlice};
use std::collections::HashMap;
use tauri::Runtime;

/// The most of one step's output that is sent to the frontend.
const MAX_OUTPUT_SIZE_BYTES: usize = 5 * 1024 * 1024;

/// Record what `rs` returned. `dataflow` is the run's steps as written, which
/// Coherence traces a save's inputs through.
pub(super) async fn record_step_result<R: Runtime>(
    ctx: &RunContext<'_, R>,
    state: &mut RunState,
    dataflow: &[StepSlice],
    rs: &ResolvedStep,
    params: &HashMap<String, String>,
    result: Result<HashMap<String, String>, String>,
    duration_ms: u64,
) {
    let step_outputs = match result {
        Ok(step_outputs) => step_outputs,
        Err(error) => {
            state.fail(&rs.id);
            ctx.errored(&rs.id, error, Some(duration_ms));
            return;
        }
    };

    if rs.step.uses == "action/save-file" {
        if let (Some(rel), Some(content)) = (params.get("path"), params.get("input")) {
            capture_save_file_ordered(
                ctx.app,
                ctx.workspace_root,
                dataflow.to_vec(),
                rs.id.clone(),
                rel.clone(),
                content.clone(),
                ctx.capture_policy,
            )
            .await;
        }
    }
    let primary_text = step_outputs.get("text").cloned().unwrap_or_default();
    state.complete(&rs.id, step_outputs);
    ctx.succeeded(
        &rs.id,
        truncate_utf8_safe(&primary_text, MAX_OUTPUT_SIZE_BYTES),
        duration_ms,
    );
}

/// Truncate a string to at most `max_bytes`, keeping only whole characters:
/// the cut falls on the last character boundary at or before the limit, and
/// a note with the full size follows it.
fn truncate_utf8_safe(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let safe_end = s
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .take_while(|end| *end <= max_bytes)
        .last()
        .unwrap_or(0);
    format!(
        "{}...\n[Output truncated for display: {} bytes total]",
        &s[..safe_end],
        s.len()
    )
}

#[cfg(test)]
#[path = "step_record.test.rs"]
mod tests;
