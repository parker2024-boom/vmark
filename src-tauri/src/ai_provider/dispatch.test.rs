//! WI-FL5.3 — `dispatch_to_provider`'s routing arms.
//!
//! Every arm is exercised with no server and no real provider: the refusals
//! are pure; a REST arm is identified by the "<Provider> request failed"
//! prefix it produces when its endpoint is a loopback port nothing listens
//! on; the CLI arms run a `/bin/sh` shim that records its stdin and prints its
//! argv — the POSIX-shim technique `cli.test.rs` already uses (WI-RA4.1: the
//! prompt reaches a CLI on stdin, never in argv). Google has no endpoint parameter
//! (its public host is hard-coded), so its arm is covered here only up to the
//! API-key refusal; its request shape is pinned in `rest_providers.test.rs`.

use super::{dispatch_to_provider, run_rest_with_cancel, ProviderRequest};
use crate::ai_provider::sink::testing::{RecordingSink, SinkEvent};
use crate::ai_provider::sink::AiSink;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn request<'a>(provider: &'a str, prompt: &'a str) -> ProviderRequest<'a> {
    ProviderRequest {
        provider,
        prompt,
        model: None,
        api_key: None,
        endpoint: None,
        cli_path: None,
        max_tokens: None,
    }
}

async fn dispatch(sink: &Arc<RecordingSink>, request: ProviderRequest<'_>) -> Result<(), String> {
    let dyn_sink: Arc<dyn AiSink> = sink.clone();
    tokio::time::timeout(
        Duration::from_secs(30),
        dispatch_to_provider(dyn_sink, CancellationToken::new(), request),
    )
    .await
    .expect("dispatch must finish: nothing here waits on a real provider")
}

/// A loopback port with nothing listening. A REST arm that reaches its
/// request builder fails at connect, immediately, with the provider's own
/// "<Name> request failed" prefix — no server needed to see which arm ran.
async fn dead_endpoint() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);
    format!("http://{addr}")
}

// ── refusals (pure) ─────────────────────────────────────────────────────────

#[tokio::test]
async fn an_unknown_provider_is_refused_on_both_channels() {
    let sink = Arc::new(RecordingSink::new());
    let result = dispatch(&sink, request("nope", "hi")).await;
    assert_eq!(result, Err("Unknown provider: nope".to_string()));
    assert_eq!(
        sink.events(),
        vec![SinkEvent::Error("Unknown provider: nope".to_string())]
    );
}

#[tokio::test]
async fn rest_providers_refuse_to_start_without_an_api_key() {
    let named = [
        ("anthropic", "Anthropic"),
        ("openai", "OpenAI"),
        ("openai-compatible", "OpenAI-compatible"),
        ("google-ai", "Google AI"),
    ];
    for (provider, name) in named {
        for key in [None, Some(String::new())] {
            let sink = Arc::new(RecordingSink::new());
            let mut req = request(provider, "hi");
            req.api_key = key.clone();
            let result = dispatch(&sink, req).await;
            assert_eq!(result, Ok(()), "{provider} with key {key:?}");
            assert_eq!(
                sink.events(),
                vec![SinkEvent::Error(format!("{name} API key is required"))],
                "{provider} with key {key:?}"
            );
        }
    }
}

#[tokio::test]
async fn openai_compatible_requires_an_endpoint_and_then_a_model() {
    let sink = Arc::new(RecordingSink::new());
    let mut req = request("openai-compatible", "hi");
    req.api_key = Some("k".to_string());
    assert_eq!(dispatch(&sink, req).await, Ok(()));
    assert_eq!(
        sink.events(),
        vec![SinkEvent::Error(
            "Endpoint (base URL) is required for the OpenAI-compatible provider".to_string()
        )]
    );

    for model in [None, Some(String::new())] {
        let sink = Arc::new(RecordingSink::new());
        let mut req = request("openai-compatible", "hi");
        req.api_key = Some("k".to_string());
        req.endpoint = Some("https://compat.example.test".to_string());
        req.model = model.clone();
        assert_eq!(dispatch(&sink, req).await, Ok(()), "model {model:?}");
        assert_eq!(
            sink.events(),
            vec![SinkEvent::Error(
                "Model is required for the OpenAI-compatible provider".to_string()
            )],
            "model {model:?}"
        );
    }
}

// ── REST arms reach their own request builder ───────────────────────────────

#[tokio::test]
async fn each_rest_arm_reaches_its_own_request_builder_and_surfaces_transport_errors_to_the_caller()
{
    let endpoint = dead_endpoint().await;
    // (provider, api key, model, expected error prefix). Ollama needs no key;
    // openai-compatible shares OpenAI's builder, so it carries OpenAI's prefix.
    let arms = [
        ("anthropic", Some("k"), None, "Anthropic request failed:"),
        ("openai", Some("k"), None, "OpenAI request failed:"),
        (
            "openai-compatible",
            Some("k"),
            Some("m"),
            "OpenAI request failed:",
        ),
        ("ollama-api", None, None, "Ollama request failed:"),
    ];
    for (provider, key, model, prefix) in arms {
        let sink = Arc::new(RecordingSink::new());
        let mut req = request(provider, "hi");
        req.api_key = key.map(String::from);
        req.model = model.map(String::from);
        req.endpoint = Some(endpoint.clone());
        let err = dispatch(&sink, req).await.expect_err(provider);
        assert!(err.starts_with(prefix), "{provider}: {err}");
        assert_eq!(
            sink.events(),
            vec![],
            "{provider}: a transport failure is returned to the caller, not doubled into the sink"
        );
    }
}

// ── CLI arms ────────────────────────────────────────────────────────────────
//
// The prompt is document text, so it must never be an argument: on Windows an
// npm-installed CLI is a `.cmd` shim, and an argument to one is parsed by
// cmd.exe. Every CLI arm hands the prompt to the child on stdin and keeps its
// argv fixed.

/// A stand-in CLI binary that saves its stdin to `<shim>.stdin`, then prints
/// each argv entry on its own line.
#[cfg(unix)]
fn recording_shim() -> (tempfile::TempDir, String) {
    crate::ai_provider::test_shim::sh_shim(
        "cat > \"$0.stdin\"\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done",
    )
}

/// What the shim's stdin held, byte for byte.
#[cfg(unix)]
fn stdin_seen_by(shim: &str) -> Vec<u8> {
    std::fs::read(format!("{shim}.stdin")).expect("the shim records its stdin")
}

/// The fixed argv each CLI provider is spawned with. None of it is caller data.
#[cfg(unix)]
const CLI_ARGV: [(&str, &[&str]); 3] = [
    ("claude", &["-p", "--output-format", "text"]),
    ("codex", &["exec", "--skip-git-repo-check", "-"]),
    ("gemini", &[]),
];

/// Text a document can hold and a shell would act on: quotes, command
/// separators, a pipe, variable expansions for cmd.exe and sh, command
/// substitutions, CRLF and LF line ends, CJK, and a trailing backslash.
#[cfg(unix)]
const HOSTILE_PROMPT: &str = "say \"hi\" & echo INJECTED | more %PATH% $HOME `id` $(id)\r\n\
     second line ^ < > ! '\n中文段落——全角标点。\nlast line ends with a backslash \\";

#[cfg(unix)]
#[tokio::test]
async fn cli_arms_deliver_the_prompt_on_stdin_byte_for_byte_and_never_in_argv() {
    for (provider, expected_argv) in CLI_ARGV {
        let (_dir, shim) = recording_shim();
        let sink = Arc::new(RecordingSink::new());
        let mut req = request(provider, HOSTILE_PROMPT);
        req.cli_path = Some(shim.clone());
        assert_eq!(dispatch(&sink, req).await, Ok(()), "{provider}");
        assert_eq!(
            stdin_seen_by(&shim),
            HOSTILE_PROMPT.as_bytes(),
            "{provider}: stdin must hold the prompt unchanged"
        );
        assert_eq!(
            sink.collected_text().lines().collect::<Vec<_>>(),
            expected_argv,
            "{provider}: argv is fixed and carries no part of the prompt"
        );
        assert_eq!(
            sink.events().last(),
            Some(&SinkEvent::Done),
            "{provider} must end with Done"
        );
    }
}

/// A prompt far larger than a pipe buffer — and than the 32,767 characters a
/// Windows command line can hold, which an argv prompt could never exceed —
/// arrives whole.
#[cfg(unix)]
#[tokio::test]
async fn a_prompt_larger_than_a_pipe_buffer_reaches_the_cli_whole() {
    let prompt = "0123456789abcdef 中文\n".repeat(64 * 1024);
    assert!(prompt.len() > 1024 * 1024);
    let (_dir, shim) = recording_shim();
    let sink = Arc::new(RecordingSink::new());
    let mut req = request("claude", &prompt);
    req.cli_path = Some(shim.clone());
    assert_eq!(dispatch(&sink, req).await, Ok(()));
    assert!(
        stdin_seen_by(&shim) == prompt.as_bytes(),
        "the whole prompt must arrive on stdin"
    );
    assert_eq!(sink.events().last(), Some(&SinkEvent::Done));
}

/// An empty prompt is an empty stdin, never an empty argument: the CLI sees
/// end-of-input and reports "no prompt" itself.
#[cfg(unix)]
#[tokio::test]
async fn an_empty_prompt_is_an_empty_stdin_not_an_empty_argument() {
    for (provider, expected_argv) in CLI_ARGV {
        let (_dir, shim) = recording_shim();
        let sink = Arc::new(RecordingSink::new());
        let mut req = request(provider, "");
        req.cli_path = Some(shim.clone());
        assert_eq!(dispatch(&sink, req).await, Ok(()), "{provider}");
        assert_eq!(stdin_seen_by(&shim), b"", "{provider}");
        assert_eq!(
            sink.collected_text().lines().collect::<Vec<_>>(),
            expected_argv,
            "{provider}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn max_tokens_neither_constrains_nor_blocks_a_cli_provider() {
    let (_dir, shim) = recording_shim();
    let sink = Arc::new(RecordingSink::new());
    let mut req = request("claude", "hello world");
    req.cli_path = Some(shim.clone());
    req.max_tokens = Some(10);
    assert_eq!(dispatch(&sink, req).await, Ok(()));
    assert_eq!(
        sink.collected_text().lines().collect::<Vec<_>>(),
        vec!["-p", "--output-format", "text"],
        "the cap is only logged (D8): no flag reaches the CLI"
    );
    assert_eq!(stdin_seen_by(&shim), b"hello world");
}

// ── cooperative cancellation around a REST call ─────────────────────────────

#[tokio::test]
async fn a_cancelled_token_short_circuits_a_rest_call_as_cancelled_not_an_error() {
    let sink = Arc::new(RecordingSink::new());
    let dyn_sink: Arc<dyn AiSink> = sink.clone();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = run_rest_with_cancel(dyn_sink, cancel, |_sink: Arc<dyn AiSink>| {
        std::future::pending::<Result<(), String>>()
    })
    .await;
    assert_eq!(
        result,
        Ok(()),
        "cancellation is an upstream signal, not a provider error"
    );
    assert_eq!(
        sink.events(),
        vec![SinkEvent::Error("Cancelled".to_string())]
    );
}

#[tokio::test]
async fn an_uncancelled_rest_call_result_passes_through_unchanged() {
    let sink = Arc::new(RecordingSink::new());
    let dyn_sink: Arc<dyn AiSink> = sink.clone();
    let ok = run_rest_with_cancel(
        dyn_sink,
        CancellationToken::new(),
        |s: Arc<dyn AiSink>| async move {
            s.done();
            Ok(())
        },
    )
    .await;
    assert_eq!(ok, Ok(()));
    assert_eq!(sink.events(), vec![SinkEvent::Done]);

    let sink = Arc::new(RecordingSink::new());
    let dyn_sink: Arc<dyn AiSink> = sink.clone();
    let err = run_rest_with_cancel(
        dyn_sink,
        CancellationToken::new(),
        |_s: Arc<dyn AiSink>| async { Err("boom".to_string()) },
    )
    .await;
    assert_eq!(err, Err("boom".to_string()));
    assert_eq!(
        sink.events(),
        vec![],
        "a provider error is not re-emitted as Cancelled"
    );
}
