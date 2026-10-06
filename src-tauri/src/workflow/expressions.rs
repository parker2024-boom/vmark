//! Expression parser for workflow parameter values (ADR-3).
//!
//! Resolves these forms inside `with:` parameter values:
//!
//! | Syntax | Resolves to |
//! |---|---|
//! | `${{ steps.ID.outputs.FIELD }}` | `outputs[ID][FIELD]` |
//! | `${{ steps.ID.output }}` | `outputs[ID]["text"]` (sugar) |
//! | `${{ env.NAME }}` | `env[NAME]` |
//! | `${VAR}` (legacy) | `env[VAR]` (preserved for backward compat) |
//! | `stepId.output` (full-string match, legacy) | `outputs[stepId]["text"]` |
//!
//! Key decisions:
//!   - **Only the template is scanned.** `resolve` walks the author's value
//!     once, left to right, and copies each reference's value into the result.
//!     A substituted value is data: a step output is a document or a model's
//!     answer, and a document that contains `${HOME}` or a JS template literal
//!     must reach the next step byte for byte. Scanning the result a second
//!     time would fail such a step on a variable it never named, or splice
//!     environment values into a prompt or a saved file.
//!   - The two `${...}` forms are one regex alternation, so there is one scan
//!     and no ordering between them: `${{` and `${NAME}` cannot both match at
//!     one position. The leftmost reference that fails is the one reported.
//!   - The bare `stepId.output` alias is decided on the template too — it is
//!     the whole value or it is nothing — so text that merely reads like an
//!     alias after substitution is never followed.
//!   - Unknown references return `Err`; this is fatal at the runner level.
//!
//! @coordinates-with condition.rs — resolves each operand with `resolve_reference`
//! @coordinates-with coherence_capture.rs — shares `bare_alias_id`
//! @module workflow::expressions

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

/// Outputs map shape used by the runner: step id → (field name → value).
pub type WorkflowOutputs = HashMap<String, HashMap<String, String>>;

/// Every in-text reference form, as one alternation: group 1 is the body of a
/// `${{ <body> }}` (whitespace-tolerant), group 2 the name of a legacy
/// `${NAME}`. One pattern is what makes `resolve` a single pass.
static REFERENCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{\{\s*([^}]+?)\s*\}\}|\$\{(\w+)\}").expect("invalid reference regex")
});

static BARE_ALIAS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][\w-]*)\.output$").expect("invalid bare alias regex"));

/// The step id a bare whole-string `stepId.output` alias names — the ONE
/// definition of that grammar, shared with `coherence_capture.rs`, which
/// carried a looser copy. `None` for anything `resolve` leaves alone.
pub(super) fn bare_alias_id(value: &str) -> Option<&str> {
    let caps = BARE_ALIAS_RE.captures(value.trim())?;
    Some(caps.get(1)?.as_str())
}

/// Errors that can arise while resolving an expression.
#[derive(Debug, Clone, PartialEq)]
pub enum ExprError {
    /// `${{ steps.X.outputs.Y }}` referenced a step that doesn't exist.
    UnknownStep(String),
    /// `${{ steps.X.outputs.Y }}` referenced a missing output field.
    MissingField { step: String, field: String },
    /// `${{ env.X }}` referenced a missing environment variable.
    UnknownEnv(String),
    /// `${{ <body> }}` had a body the parser couldn't recognize.
    Unsupported(String),
}

impl std::fmt::Display for ExprError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExprError::UnknownStep(s) => write!(f, "Reference to unknown step '{}'", s),
            ExprError::MissingField { step, field } => {
                write!(f, "Step '{}' output '{}' not available", step, field)
            }
            ExprError::UnknownEnv(name) => write!(f, "Reference to unknown env var '{}'", name),
            ExprError::Unsupported(body) => {
                write!(f, "Unsupported expression: ${{{{ {} }}}}", body)
            }
        }
    }
}

/// Resolve every supported reference form in the template `value`.
///
/// One left-to-right pass over `value`: the text between references is copied
/// as written, each reference is replaced by its value, and no value is ever
/// scanned — so whatever a step produced arrives unchanged.
pub fn resolve(
    value: &str,
    outputs: &WorkflowOutputs,
    env: &HashMap<String, String>,
) -> Result<String, ExprError> {
    // Legacy whole-value alias. Judged on the template: such a value contains
    // no `$`, so there is nothing else in it to resolve.
    if let Some(id) = bare_alias_id(value) {
        return step_field(outputs, id, "text").cloned();
    }

    let mut resolved = String::with_capacity(value.len());
    let mut last_end = 0;
    for caps in REFERENCE_RE.captures_iter(value) {
        let whole = caps.get(0).expect("regex match always has whole");
        resolved.push_str(&value[last_end..whole.start()]);
        match (caps.get(1), caps.get(2)) {
            (Some(body), _) => {
                resolved.push_str(&resolve_reference(body.as_str(), outputs, env)?);
            }
            // Legacy `${VAR}`. Strict like `${{ env.VAR }}`: an unknown name is
            // fatal, so an author's typo never becomes an empty prompt or path.
            (None, Some(name)) => resolved.push_str(env_value(env, name.as_str())?),
            (None, None) => resolved.push_str(whole.as_str()),
        }
        last_end = whole.end();
    }
    resolved.push_str(&value[last_end..]);
    Ok(resolved)
}

/// Resolve ONE reference — the body of a `${{ ... }}` — to its value:
/// `env.NAME`, `steps.ID.output`, or `steps.ID.outputs.FIELD`.
///
/// The `if:` evaluator resolves each operand through this rather than through
/// `resolve`: an operand is a single reference, not a template.
pub(super) fn resolve_reference(
    body: &str,
    outputs: &WorkflowOutputs,
    env: &HashMap<String, String>,
) -> Result<String, ExprError> {
    let body = body.trim();

    if let Some(name) = body.strip_prefix("env.") {
        return env_value(env, name).cloned();
    }

    if let Some(rest) = body.strip_prefix("steps.") {
        let parts: Vec<&str> = rest.split('.').collect();
        match parts.as_slice() {
            [id, "output"] => return step_field(outputs, id, "text").cloned(),
            [id, "outputs", field] => return step_field(outputs, id, field).cloned(),
            _ => {}
        }
    }

    Err(ExprError::Unsupported(body.to_string()))
}

fn env_value<'a>(env: &'a HashMap<String, String>, name: &str) -> Result<&'a String, ExprError> {
    env.get(name)
        .ok_or_else(|| ExprError::UnknownEnv(name.to_string()))
}

fn step_field<'a>(
    outputs: &'a WorkflowOutputs,
    id: &str,
    field: &str,
) -> Result<&'a String, ExprError> {
    outputs
        .get(id)
        .ok_or_else(|| ExprError::UnknownStep(id.to_string()))?
        .get(field)
        .ok_or_else(|| ExprError::MissingField {
            step: id.to_string(),
            field: field.to_string(),
        })
}

#[cfg(test)]
#[path = "expressions.test.rs"]
mod tests;
