// WI-RA5.3 — the execute phase, split out of the runner: a step is routed by
// its `uses:` prefix, and a prefix nothing can run is an error, never a pass.
//
//! Unit tests for `step_execute.rs`. The timeout itself is exercised through a
//! whole run in `runner_flow.test.rs`.

use super::*;
use crate::workflow::types::NeedsDef;

fn step_with_uses(uses: &str) -> RawStep {
    RawStep {
        id: Some("s".into()),
        uses: uses.into(),
        with: HashMap::new(),
        needs: NeedsDef::None,
        condition: None,
        model: None,
        approval: None,
        limits: None,
    }
}

#[tokio::test]
async fn test_execute_step_unknown_type() {
    let params = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let defaults = RawDefaults::default();
    let result = execute_step(
        &step_with_uses("unknown/thing"),
        &params,
        root,
        CancellationToken::new(),
        None,
        None,
        &defaults,
    )
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_genie_step_without_provider_returns_error() {
    // Without an active provider configured, a genie step fails fast
    // with a clear message rather than panicking.
    let params = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let defaults = RawDefaults::default();
    let result = execute_step(
        &step_with_uses("genie/summarize"),
        &params,
        root,
        CancellationToken::new(),
        None,
        None,
        &defaults,
    )
    .await;
    assert!(matches!(result, Err(ref e) if e.contains("provider")));
}

#[tokio::test]
async fn test_webhook_step_returns_error() {
    let params = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let defaults = RawDefaults::default();
    let result = execute_step(
        &step_with_uses("webhook/stripe"),
        &params,
        root,
        CancellationToken::new(),
        None,
        None,
        &defaults,
    )
    .await;
    assert!(result.is_err());
}
