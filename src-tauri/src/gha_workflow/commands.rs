//! Tauri command surface for the GHA workflow viewer.
//!
//! Origin: GitHub Actions workflow viewer plan (retired)
//! for `gha_lint` and `gha_fetch_action_yml`.

use super::action_fetch::{default_ttl_secs, fetch_metadata, FetchResult};
use super::actionlint::{run_actionlint, LintResult};
use crate::command_error::CommandError;
use tauri::AppHandle;

/// Run actionlint on a YAML string. Returns a typed `LintResult` so the
/// frontend can distinguish binary-missing (silent fallback) from
/// binary-failed (surfaced error).
///
/// Only the YAML comes from the webview. Which `actionlint` runs, and the
/// PATH it runs with, are decided here from the login-shell PATH, so macOS GUI
/// launches still find a Homebrew install. The webview used to supply that
/// PATH itself, which let page content choose the program the backend runs.
///
/// # Errors
/// `internal` when the blocking task itself failed.
#[tauri::command]
pub async fn gha_lint(yaml: String) -> Result<LintResult, CommandError> {
    // Run on the blocking pool so it doesn't starve tokio.
    tokio::task::spawn_blocking(move || {
        run_actionlint(&yaml, &crate::ai_provider::login_shell_path())
    })
    .await
    .map_err(|e| CommandError::internal(format!("Lint task join failed: {e}")))
}

/// Fetch an action's `action.yml` (or `.yaml`) and parse it into typed
/// metadata. Cache hit returns immediately; cache miss falls through
/// to a network fetch from raw.githubusercontent.com.
///
/// Always returns `Ok(FetchResult)` — the typed enum carries the
/// success/failure variant. Outer `Err` is reserved for fatal Tauri
/// runtime errors that the frontend can't usefully recover from.
#[tauri::command]
pub async fn gha_fetch_action_yml(app: AppHandle, uses: String) -> Result<FetchResult, String> {
    Ok(fetch_metadata(&app, &uses, default_ttl_secs()).await)
}
