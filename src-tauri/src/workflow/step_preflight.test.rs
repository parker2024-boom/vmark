// WI-RA5.3 — the preflight phase, split out of the runner: a step's `with:`
// values are resolved against earlier outputs and the environment, and a
// `path` is re-validated against the workspace after substitution.
//
//! Unit tests for `step_preflight.rs`. Whether a step runs at all — cancel and
//! `if:` — is exercised through whole runs in `runner_flow.test.rs`.

use super::*;

#[test]
fn test_resolve_params_output_ref_missing() {
    let mut params = HashMap::new();
    params.insert("input".to_string(), "missing.output".to_string());
    let outputs = WorkflowOutputs::new();
    let env = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let result = resolve_params(&params, &outputs, &env, root);
    assert!(result.is_err());
}

#[test]
fn test_resolve_params_steps_outputs_field() {
    // WI-2.3: ${{ steps.X.outputs.Y }} resolves to outputs[X][Y].
    let mut params = HashMap::new();
    params.insert(
        "input".to_string(),
        "${{ steps.outline.outputs.text }}".to_string(),
    );
    let mut outputs = WorkflowOutputs::new();
    outputs.insert(
        "outline".to_string(),
        HashMap::from([("text".to_string(), "section list".to_string())]),
    );
    let env = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let resolved = resolve_params(&params, &outputs, &env, root).unwrap();
    assert_eq!(resolved.get("input").unwrap(), "section list");
}

#[test]
fn test_resolve_params_bare_alias_still_works() {
    // Backward compat: stepId.output reads outputs[id]["text"].
    let mut params = HashMap::new();
    params.insert("input".to_string(), "outline.output".to_string());
    let mut outputs = WorkflowOutputs::new();
    outputs.insert(
        "outline".to_string(),
        HashMap::from([("text".to_string(), "compat ok".to_string())]),
    );
    let env = HashMap::new();
    let root = std::path::Path::new("/tmp");
    let resolved = resolve_params(&params, &outputs, &env, root).unwrap();
    assert_eq!(resolved.get("input").unwrap(), "compat ok");
}

#[test]
fn a_path_is_validated_after_substitution() {
    // The template is harmless; the value it resolves to leaves the workspace.
    let workspace = tempfile::tempdir().expect("workspace");
    let params = HashMap::from([("path".to_string(), "${DIR}/notes.md".to_string())]);
    let outputs = WorkflowOutputs::new();

    let inside = HashMap::from([("DIR".to_string(), "drafts".to_string())]);
    let resolved = resolve_params(&params, &outputs, &inside, workspace.path()).unwrap();
    assert_eq!(resolved.get("path").unwrap(), "drafts/notes.md");

    let outside = HashMap::from([("DIR".to_string(), "..".to_string())]);
    let err = resolve_params(&params, &outputs, &outside, workspace.path())
        .expect_err("`..` leaves the workspace");
    assert!(
        err.starts_with("Path validation failed after parameter resolution:"),
        "{err}"
    );
}

#[test]
fn an_unresolvable_parameter_is_an_error_not_an_empty_value() {
    let params = HashMap::from([("input".to_string(), "${NOPE}".to_string())]);
    let err = resolve_params(
        &params,
        &WorkflowOutputs::new(),
        &HashMap::new(),
        Path::new("/tmp"),
    )
    .expect_err("an unknown variable");
    assert_eq!(err, "Reference to unknown env var 'NOPE'");
}
