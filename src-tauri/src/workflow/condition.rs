// RW-6 (L10) — workflow if: expression evaluation
// audit-fix — cap condition parser recursion depth
//
//! Boolean condition evaluator for workflow steps' `if:` field.
//!
//! Replaces the old literal-`false`/`0` check with a real expression
//! evaluator: a tokenizer + Pratt parser supporting GitHub-Actions-style
//! conditions. The whole condition may be wrapped in one `${{ ... }}`.
//!
//! Supported grammar:
//!
//! | Form | Meaning |
//! |---|---|
//! | `true` / `false` (case-insensitive) | boolean literal |
//! | `1` / `0` | truthy / falsy literal |
//! | `success()`, `failure()`, `always()` | status functions over the run so far (see `condition_status.rs`) |
//! | no status function named | `success()` is implied: `if: X` means `success() && (X)` |
//! | `'str'` / `"str"` | string literal operand |
//! | number | numeric operand |
//! | `${{ ... }}`, `steps.X.outputs.Y`, `env.NAME` | reference operands (one reference each, via `expressions::resolve_reference`) |
//! | `==`, `!=` | equality (numeric if both parse as f64, else string) |
//! | `>`, `<`, `>=`, `<=` | numeric comparison |
//! | `&&`, `\|\|`, `!`, `( )` | boolean composition (`&&`/`\|\|` short-circuit: a dead RHS is parsed but never resolved) |
//!
//! Fail-loud: any unparseable or unsupported condition returns `Err(String)`.
//! The runner MUST treat that `Err` as a step failure, never as a silent pass.

use std::collections::HashMap;

use super::condition_lexer::{strip_outer_wrapper, tokenize, Token};
use super::expressions::{self, WorkflowOutputs};

/// The run status a condition is judged under, split out at the size limit.
#[path = "condition_status.rs"]
mod condition_status;
pub use condition_status::RunStatus;
use condition_status::StatusFn;

/// Evaluate a step's `if:` condition to a boolean: does the step run?
///
/// `status` is the run so far, which `success()` / `failure()` read. A
/// condition that names no status function carries an implied `success()`, so
/// once the run cannot succeed it is a dead branch: parsed, so a syntax error
/// still surfaces, but never evaluated. On any malformed or unsupported input
/// this returns `Err` — callers must surface it as a step failure rather than
/// defaulting to "run the step".
pub fn evaluate_condition(
    condition: &str,
    outputs: &WorkflowOutputs,
    env: &HashMap<String, String>,
    status: RunStatus,
) -> Result<bool, String> {
    let stripped = strip_outer_wrapper(condition.trim());
    let tokens = tokenize(stripped)?;
    let names_status_fn = tokens.iter().any(
        |token| matches!(token, Token::Operand { text, is_ref: true } if StatusFn::parse(text).is_some()),
    );
    let dead = !names_status_fn && !status.succeeded();
    let mut parser = Parser {
        tokens,
        pos: 0,
        outputs,
        env,
        status,
    };
    let value = parser.parse_expr(0, 0, dead)?;
    if parser.pos != parser.tokens.len() {
        return Err(format!(
            "Unexpected trailing tokens in condition: {}",
            condition
        ));
    }
    Ok(!dead && value.truthy())
}

// === Values ===

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Bool(bool),
    /// String operand (also covers resolved refs and quoted literals).
    Str(String),
}

impl Value {
    fn truthy(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            // A string operand standing alone is truthy when non-empty and
            // not a falsy literal. This mirrors GitHub Actions treating
            // non-empty strings as truthy.
            Value::Str(s) => {
                let t = s.trim();
                !t.is_empty() && !t.eq_ignore_ascii_case("false") && t != "0"
            }
        }
    }

    fn as_string(&self) -> String {
        match self {
            Value::Bool(b) => b.to_string(),
            Value::Str(s) => s.clone(),
        }
    }

    fn as_number(&self) -> Option<f64> {
        match self {
            Value::Bool(_) => None,
            Value::Str(s) => s.trim().parse::<f64>().ok(),
        }
    }
}

// === Parser (Pratt) ===
// Tokens come from `condition_lexer::tokenize` (split into a sibling module
// to keep this file within the size ratchet).

/// Maximum nesting depth for the recursive-descent / Pratt parser.
///
/// Every prefix `!`, parenthesized group, and binary sub-expression recurses,
/// so a crafted condition (e.g. thousands of nested parens or a long run of
/// `!`) could otherwise blow the stack — a DoS via a malicious workflow file.
/// Real conditions never nest more than a handful of levels; 100 is comfortably
/// above any legitimate use yet well below the native stack-overflow threshold.
/// On overflow the parser returns `Err`, which the runner surfaces as a step
/// failure (fail-loud), never as a silent pass.
const MAX_PARSE_DEPTH: usize = 100;

struct Parser<'a> {
    tokens: Vec<Token>,
    pos: usize,
    outputs: &'a WorkflowOutputs,
    env: &'a HashMap<String, String>,
    status: RunStatus,
}

impl Parser<'_> {
    fn peek_tok(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    /// Binding power for binary operators. Higher binds tighter.
    /// `||` < `&&` < comparisons.
    fn binary_bp(tok: &Token) -> Option<u8> {
        match tok {
            Token::Or => Some(1),
            Token::And => Some(2),
            Token::Eq | Token::Ne | Token::Gt | Token::Lt | Token::Ge | Token::Le => Some(3),
            _ => None,
        }
    }

    /// Parse (and evaluate) an expression. When `skip` is true the tokens are
    /// consumed with full syntax checking but nothing is *evaluated*: operand
    /// resolution and operator application are bypassed, so a dead branch of
    /// `&&` / `||` (GitHub-Actions-style short-circuit) cannot fail the
    /// condition via a missing reference or type error. Syntax errors still
    /// surface — short-circuiting skips evaluation, never parsing.
    fn parse_expr(&mut self, min_bp: u8, depth: usize, skip: bool) -> Result<Value, String> {
        if depth > MAX_PARSE_DEPTH {
            return Err(format!(
                "Condition nesting too deep (max {})",
                MAX_PARSE_DEPTH
            ));
        }
        let mut lhs = self.parse_prefix(depth + 1, skip)?;

        while let Some(tok) = self.peek_tok() {
            let Some(bp) = Self::binary_bp(tok) else {
                break;
            };
            if bp < min_bp {
                break;
            }
            // Clone the peeked operator and consume it in one step — no second
            // lookup that could panic if peek and advance ever disagreed
            // (release builds abort on panic; this parser sees user input).
            let op = tok.clone();
            self.pos += 1;
            // Short-circuit: once the LHS decides an `&&` / `||`, the RHS is
            // parsed in skip mode (dead branch).
            let rhs_skip = skip
                || match op {
                    Token::And => !lhs.truthy(),
                    Token::Or => lhs.truthy(),
                    _ => false,
                };
            let rhs = self.parse_expr(bp + 1, depth + 1, rhs_skip)?;
            lhs = if skip {
                // Dead branch: keep parsing, never evaluate. The value is a
                // placeholder the caller discards.
                Value::Bool(false)
            } else {
                match op {
                    Token::And => Value::Bool(lhs.truthy() && !rhs_skip && rhs.truthy()),
                    Token::Or => Value::Bool(lhs.truthy() || (!rhs_skip && rhs.truthy())),
                    _ => self.apply_binary(&op, lhs, rhs)?,
                }
            };
        }

        Ok(lhs)
    }

    fn parse_prefix(&mut self, depth: usize, skip: bool) -> Result<Value, String> {
        if depth > MAX_PARSE_DEPTH {
            return Err(format!(
                "Condition nesting too deep (max {})",
                MAX_PARSE_DEPTH
            ));
        }
        match self.advance() {
            Some(Token::Not) => {
                let v = self.parse_prefix(depth + 1, skip)?;
                Ok(Value::Bool(!v.truthy()))
            }
            Some(Token::LParen) => {
                let v = self.parse_expr(0, depth + 1, skip)?;
                match self.advance() {
                    Some(Token::RParen) => Ok(v),
                    _ => Err("Expected ')'".to_string()),
                }
            }
            Some(Token::Operand { text, is_ref }) => {
                if skip {
                    // Dead branch: syntax-check only; never resolve references
                    // or literals, so a missing ref cannot fail the condition.
                    return Ok(Value::Bool(false));
                }
                self.resolve_operand(&text, is_ref)
            }
            Some(other) => Err(format!(
                "Unexpected operator where operand expected: {:?}",
                other
            )),
            None => Err("Unexpected end of condition".to_string()),
        }
    }

    /// Resolve an operand token to a `Value`.
    fn resolve_operand(&self, text: &str, is_ref: bool) -> Result<Value, String> {
        if !is_ref {
            // Quoted string literal — verbatim.
            return Ok(Value::Str(text.to_string()));
        }

        let t = text.trim();

        // Boolean / truthy literals (case-insensitive for true/false).
        if t.eq_ignore_ascii_case("true") {
            return Ok(Value::Bool(true));
        }
        if t.eq_ignore_ascii_case("false") {
            return Ok(Value::Bool(false));
        }
        if t == "1" {
            return Ok(Value::Bool(true));
        }
        if t == "0" {
            return Ok(Value::Bool(false));
        }

        if let Some(status_fn) = StatusFn::parse(t) {
            return Ok(Value::Bool(status_fn.evaluate(self.status)));
        }

        // Plain number operand.
        if t.parse::<f64>().is_ok() {
            return Ok(Value::Str(t.to_string()));
        }

        // Reference: `${{ ... }}`, `steps.X...`, or `env.NAME` — ONE reference,
        // resolved as one. An operand is not a template: what it resolves to
        // is a value, and is never scanned for further references.
        let body = match t.strip_prefix("${{").map(|rest| rest.strip_suffix("}}")) {
            Some(Some(inner)) => inner,
            Some(None) => return Err(format!("Unterminated `${{{{` reference: '{}'", t)),
            None if t.starts_with("steps.") || t.starts_with("env.") => t,
            None => return Err(format!("Unsupported operand in condition: '{}'", t)),
        };

        expressions::resolve_reference(body, self.outputs, self.env)
            .map(Value::Str)
            .map_err(|e| format!("Condition reference failed: {}", e))
    }

    /// Apply a comparison operator. `&&` / `||` are handled (with
    /// short-circuit) directly in `parse_expr` and never reach here.
    fn apply_binary(&self, op: &Token, lhs: Value, rhs: Value) -> Result<Value, String> {
        match op {
            Token::Eq | Token::Ne => {
                let eq = match (lhs.as_number(), rhs.as_number()) {
                    (Some(a), Some(b)) => a == b,
                    _ => lhs.as_string() == rhs.as_string(),
                };
                Ok(Value::Bool(if matches!(op, Token::Eq) { eq } else { !eq }))
            }
            Token::Gt | Token::Lt | Token::Ge | Token::Le => {
                let a = lhs.as_number().ok_or_else(|| {
                    format!("Non-numeric operand in comparison: '{}'", lhs.as_string())
                })?;
                let b = rhs.as_number().ok_or_else(|| {
                    format!("Non-numeric operand in comparison: '{}'", rhs.as_string())
                })?;
                let result = match op {
                    Token::Gt => a > b,
                    Token::Lt => a < b,
                    Token::Ge => a >= b,
                    Token::Le => a <= b,
                    // Defensive: the outer arm restricts `op` to the four
                    // comparison tokens, but this parser runs on user-authored
                    // workflow YAML and the release profile aborts on panic —
                    // fail with a parse error, never `unreachable!()`.
                    other => {
                        return Err(format!("Unexpected comparison operator: {:?}", other));
                    }
                };
                Ok(Value::Bool(result))
            }
            other => Err(format!("Unexpected binary operator: {:?}", other)),
        }
    }
}

#[cfg(test)]
#[path = "condition.test.rs"]
mod tests;
