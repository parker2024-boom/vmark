//! Step phase 3 — execution under the step's timeout (split from `runner.rs`
//! at the file-size limit).
//!
//! Key decisions:
//!   - Each step runs under its OWN cancellation token, a child of the run's.
//!     The user's cancel reaches it through the parent; a timeout fires only
//!     the child, so the step's in-flight provider work (CLI child, REST
//!     request) is aborted without cancelling the `failure()` / `always()`
//!     step that runs next.
//!   - `genie/*` steps run via `genie_step`; `webhook/*` returns `Err`, not a
//!     fake `Ok`. A genie step with no provider or no genies directory fails
//!     with a message rather than panicking, so action-only workflows run
//!     from contexts that have not selected a provider.
//!
//! @coordinates-with runner.rs — calls this after the approval gate
//! @coordinates-with actions.rs — the built-in `action/*` steps
//! @coordinates-with genie_step.rs — the `genie/*` steps
//! @module workflow::step_execute

use super::run_context::RunContext;
use crate::workflow::actions::execute_action;
use crate::workflow::genie_step::{self, LoadedGenie, ProviderConfig};
use crate::workflow::step_config::{resolve_step_config, StepConfig};
use crate::workflow::types::{RawDefaults, RawStep};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tauri::Runtime;
use tokio_util::sync::CancellationToken;

/// Run the step, giving it `config.timeout_secs`. On expiry the step's
/// in-flight work is cancelled and the step fails with `Timed out after Ns`.
pub(super) async fn execute_with_timeout<R: Runtime>(
    ctx: &RunContext<'_, R>,
    step: &RawStep,
    params: &HashMap<String, String>,
    config: &StepConfig,
) -> Result<HashMap<String, String>, String> {
    let step_cancel = ctx.cancel.child_token();
    let execution = execute_step(
        step,
        params,
        ctx.workspace_root,
        step_cancel.clone(),
        ctx.provider.as_ref(),
        ctx.genies_dir.as_deref(),
        &ctx.defaults,
    );
    match tokio::time::timeout(Duration::from_secs(config.timeout_secs), execution).await {
        Ok(result) => result,
        Err(_elapsed) => {
            step_cancel.cancel();
            Err(format!("Timed out after {}s", config.timeout_secs))
        }
    }
}

/// Execute a single step based on its `uses:` prefix.
///
/// Returns the step's outputs (field → value). Action steps and
/// v0/v1-text genies populate just `{"text": ...}`; v1-JSON genies populate
/// each declared schema field as a sibling of `text`.
///
/// `genie/*` steps require `provider` and `genies_dir` — passing `None` for
/// either causes the step to fail with a clear error rather than panic, so
/// action-only workflows can run from contexts that haven't selected a
/// provider yet.
async fn execute_step(
    step: &RawStep,
    params: &HashMap<String, String>,
    workspace_root: &Path,
    cancel: CancellationToken,
    provider: Option<&ProviderConfig>,
    genies_dir: Option<&Path>,
    defaults: &RawDefaults,
) -> Result<HashMap<String, String>, String> {
    let uses = step.uses.as_str();
    if uses.starts_with("action/") {
        let text = execute_action(uses, params, workspace_root).await?;
        Ok(HashMap::from([("text".to_string(), text)]))
    } else if uses.starts_with("genie/") {
        execute_genie_step(step, params, cancel, provider, genies_dir, defaults).await
    } else if uses.starts_with("webhook/") {
        Err(format!("Webhook '{}' execution not yet implemented", uses))
    } else {
        Err(format!("Unknown step type: {}", uses))
    }
}

/// Resolve and execute a `genie/<name>` step.
///
/// Walks: name extraction → file discovery → frontmatter parse → input
/// validation → template fill → AI provider call → output validation.
/// Each failure mode produces a step-level error string suitable for the
/// `workflow:step-update` event payload.
async fn execute_genie_step(
    step: &RawStep,
    params: &HashMap<String, String>,
    cancel: CancellationToken,
    provider: Option<&ProviderConfig>,
    genies_dir: Option<&Path>,
    defaults: &RawDefaults,
) -> Result<HashMap<String, String>, String> {
    let name = genie_step::parse_genie_name(&step.uses).map_err(|e| e.to_string())?;
    let provider = provider.ok_or_else(|| {
        format!(
            "Genie '{}' requires an active AI provider — none configured for this workflow run",
            name
        )
    })?;
    let genies_dir = genies_dir.ok_or_else(|| {
        format!(
            "Genie '{}' requires a genies directory — none resolved for this workflow run",
            name
        )
    })?;

    let genie_path = genie_step::find_genie_file(genies_dir, name).map_err(|e| e.to_string())?;
    // Use tokio::fs to avoid blocking the runtime worker on slow disks.
    let raw = tokio::fs::read_to_string(&genie_path).await.map_err(|e| {
        format!(
            "Failed to read genie file '{}': {}",
            genie_path.display(),
            e
        )
    })?;

    // Parsed by the same function the editor uses, so v0 and v1 frontmatter
    // behave identically in both places.
    let content = parse_genie_content(&raw, &genie_path)?;

    let step_config = resolve_step_config(step, Some(&content.metadata), defaults);

    let loaded = LoadedGenie {
        metadata: content.metadata,
        template: content.template,
    };

    genie_step::execute_genie(cancel, &loaded, params, &step_config, provider)
        .await
        .map_err(|e| e.to_string())
}

/// Parse a genie file's content for the runner.
///
/// The editor reaches the parser through the `read_genie` Tauri command, which
/// cannot be called from inside another command's async handler without
/// re-entering the IPC layer; this calls the same parser directly.
pub(super) fn parse_genie_content(
    raw: &str,
    path: &Path,
) -> Result<crate::genies::types::GenieContent, String> {
    let path_str = path.to_string_lossy();
    crate::genies::parse_genie_for_runner(raw, &path_str)
        .map_err(|e| format!("Failed to parse genie '{}': {}", path.display(), e))
}

#[cfg(test)]
#[path = "step_execute.test.rs"]
mod tests;
