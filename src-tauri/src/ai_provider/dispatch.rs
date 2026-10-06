//! Provider dispatch shared by the streaming and collect entry points.
//!
//! Split out of `mod.rs` when `dispatch_to_provider` traded its nine-argument
//! signature (`#[allow(clippy::too_many_arguments)]`) for the
//! `ProviderRequest` params struct.
//!
//! Key decision: a CLI provider is spawned with a fixed argv
//! (`cli_stdin_args`) and given the prompt on stdin. The prompt is document
//! text; as an argument it would be parsed by cmd.exe behind a Windows `.cmd`
//! shim, and would be bounded by the platform's argument-size limit.

use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use super::sink::AiSink;
use super::types::require_api_key;
use super::{cli, endpoint, rest_providers};

/// What to run: provider selector plus its per-call inputs. The execution
/// context (`sink`, `cancel`) stays a separate argument pair — this struct is
/// the request, not the plumbing.
pub(super) struct ProviderRequest<'a> {
    pub provider: &'a str,
    pub prompt: &'a str,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub cli_path: Option<String>,
    pub max_tokens: Option<u64>,
}

/// The fixed argv that puts a CLI provider in its non-interactive mode with
/// the prompt read from stdin, or `None` for a provider that is not a CLI.
///
/// Nothing here is caller data: the prompt is document text and reaches the
/// child on stdin only (`cli/prompt.rs`). All three CLIs have a stdin mode, so
/// none keeps the prompt in argv.
fn cli_stdin_args(provider: &str) -> Option<&'static [&'static str]> {
    match provider {
        // Print mode with no prompt argument reads the prompt from stdin.
        "claude" => Some(&["-p", "--output-format", "text"]),
        // `-` in the prompt position is codex's "read instructions from stdin".
        "codex" => Some(&["exec", "--skip-git-repo-check", "-"]),
        // With no prompt argument and a stdin that is not a terminal, gemini
        // runs headless on what stdin holds.
        "gemini" => Some(&[]),
        _ => None,
    }
}

/// Provider dispatch shared between `run_ai_prompt` (window streaming) and
/// `run_ai_prompt_collect` (channel-collect for the workflow runner).
///
/// The `cancel` token is forwarded to providers that support cooperative
/// cancellation (today: every CLI provider; REST providers honor the token
/// via `tokio::select!` at call sites that wrap them).
pub(super) async fn dispatch_to_provider(
    sink: Arc<dyn AiSink>,
    cancel: CancellationToken,
    request: ProviderRequest<'_>,
) -> Result<(), String> {
    let ProviderRequest {
        provider,
        prompt,
        model,
        api_key,
        endpoint,
        cli_path,
        max_tokens,
    } = request;

    // CLI providers — run on tokio::process so kill() works from another task.
    if let Some(args) = cli_stdin_args(provider) {
        // CLI providers don't honor max_tokens — log once per call if set so
        // authors aren't silently misled into thinking it's enforced (D8).
        if max_tokens.is_some() {
            log::warn!(
                "max_tokens={:?} is not enforced for CLI provider {:?}; the genie step will run unconstrained",
                max_tokens, provider
            );
        }
        return cli::run_cli_blocking(
            sink,
            cancel,
            provider,
            args.iter().map(|arg| (*arg).to_string()).collect(),
            Some(prompt.to_string()),
            cli_path,
        )
        .await;
    }

    match provider {
        // REST providers — cooperative cancellation via tokio::select!. If
        // the caller cancels, we drop the in-flight request and emit Cancelled.
        "anthropic" => {
            let Some(key) = require_api_key(sink.as_ref(), &api_key, "Anthropic") else {
                return Ok(());
            };
            let endpoint = endpoint::resolve_endpoint(endpoint, "https://api.anthropic.com");
            let model = model.unwrap_or_else(|| "claude-sonnet-4-5-20250929".to_string());
            run_rest_with_cancel(sink, cancel, |s| async move {
                rest_providers::run_rest_anthropic(
                    s.as_ref(),
                    &endpoint,
                    key,
                    &model,
                    prompt,
                    max_tokens,
                )
                .await
            })
            .await
        }
        "openai" => {
            let Some(key) = require_api_key(sink.as_ref(), &api_key, "OpenAI") else {
                return Ok(());
            };
            let endpoint = endpoint::resolve_endpoint(endpoint, "https://api.openai.com");
            let model = model.unwrap_or_else(|| "gpt-4o".to_string());
            run_rest_with_cancel(sink, cancel, |s| async move {
                rest_providers::run_rest_openai(
                    s.as_ref(),
                    &endpoint,
                    key,
                    &model,
                    prompt,
                    max_tokens,
                )
                .await
            })
            .await
        }
        "openai-compatible" => {
            let Some(key) = require_api_key(sink.as_ref(), &api_key, "OpenAI-compatible") else {
                return Ok(());
            };
            // Generic provider — no default host; an empty endpoint is a hard error.
            let endpoint = endpoint::resolve_endpoint(endpoint, "");
            if endpoint.is_empty() {
                sink.error("Endpoint (base URL) is required for the OpenAI-compatible provider");
                return Ok(());
            }
            let model = model.unwrap_or_default();
            if model.is_empty() {
                sink.error("Model is required for the OpenAI-compatible provider");
                return Ok(());
            }
            run_rest_with_cancel(sink, cancel, |s| async move {
                rest_providers::run_rest_openai(
                    s.as_ref(),
                    &endpoint,
                    key,
                    &model,
                    prompt,
                    max_tokens,
                )
                .await
            })
            .await
        }
        "google-ai" => {
            let Some(key) = require_api_key(sink.as_ref(), &api_key, "Google AI") else {
                return Ok(());
            };
            let model = model.unwrap_or_else(|| "gemini-2.0-flash".to_string());
            run_rest_with_cancel(sink, cancel, |s| async move {
                rest_providers::run_rest_google(s.as_ref(), key, &model, prompt, max_tokens).await
            })
            .await
        }
        "ollama-api" => {
            let endpoint = endpoint::resolve_endpoint(endpoint, "http://localhost:11434");
            let model = model.unwrap_or_else(|| "llama3.2".to_string());
            run_rest_with_cancel(sink, cancel, |s| async move {
                rest_providers::run_rest_ollama(s.as_ref(), &endpoint, &model, prompt, max_tokens)
                    .await
            })
            .await
        }

        _ => {
            sink.error(&format!("Unknown provider: {}", provider));
            Err(format!("Unknown provider: {}", provider))
        }
    }
}

/// Wrap a REST provider call with cooperative cancellation. If the cancel
/// token fires while the request is in flight, we drop the request future,
/// emit "Cancelled" through the sink, and return Ok (the runner treats
/// cancellation as an upstream signal, not a provider error).
async fn run_rest_with_cancel<F, Fut>(
    sink: Arc<dyn AiSink>,
    cancel: CancellationToken,
    f: F,
) -> Result<(), String>
where
    F: FnOnce(Arc<dyn AiSink>) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let sink_for_call = Arc::clone(&sink);
    tokio::select! {
        _ = cancel.cancelled() => {
            sink.error("Cancelled");
            Ok(())
        }
        result = f(sink_for_call) => result,
    }
}

#[cfg(test)]
#[path = "dispatch.test.rs"]
mod tests;
