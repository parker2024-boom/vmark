// WI-RA5.1 — references resolve in one left-to-right pass over the template;
// substituted values (step outputs, env values) are never scanned again.
//
//! Unit tests for the workflow expression resolver (see `expressions.rs`).
//! Split into a sibling file (included via `#[path]`) to keep the production
//! file under the size gate.

use super::*;

fn outputs(pairs: &[(&str, &[(&str, &str)])]) -> WorkflowOutputs {
    pairs
        .iter()
        .map(|(id, fields)| {
            (
                (*id).to_string(),
                fields
                    .iter()
                    .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                    .collect(),
            )
        })
        .collect()
}

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

// === ${{ steps.X.outputs.Y }} ===

#[test]
fn resolves_steps_outputs_field() {
    let o = outputs(&[("first", &[("text", "ok"), ("score", "9")])]);
    let r = resolve("${{ steps.first.outputs.score }}", &o, &HashMap::new()).unwrap();
    assert_eq!(r, "9");
}

#[test]
fn unknown_step_errors() {
    let r = resolve(
        "${{ steps.ghost.outputs.text }}",
        &HashMap::new(),
        &HashMap::new(),
    );
    assert!(matches!(r, Err(ExprError::UnknownStep(_))));
}

#[test]
fn missing_field_errors() {
    let o = outputs(&[("first", &[("text", "ok")])]);
    let r = resolve("${{ steps.first.outputs.score }}", &o, &HashMap::new());
    assert!(
        matches!(r, Err(ExprError::MissingField { ref step, ref field }) if step == "first" && field == "score")
    );
}

// === ${{ steps.X.output }} sugar ===

#[test]
fn resolves_steps_output_sugar() {
    let o = outputs(&[("first", &[("text", "default")])]);
    let r = resolve("${{ steps.first.output }}", &o, &HashMap::new()).unwrap();
    assert_eq!(r, "default");
}

// === ${{ env.NAME }} ===

#[test]
fn resolves_env() {
    let r = resolve(
        "${{ env.HOME }}",
        &HashMap::new(),
        &env(&[("HOME", "/home/x")]),
    )
    .unwrap();
    assert_eq!(r, "/home/x");
}

#[test]
fn unknown_env_errors() {
    let r = resolve("${{ env.MISSING }}", &HashMap::new(), &HashMap::new());
    assert!(matches!(r, Err(ExprError::UnknownEnv(_))));
}

// === legacy ${VAR} ===

#[test]
fn legacy_env_var_still_works() {
    let r = resolve(
        "path/${HOME}/file",
        &HashMap::new(),
        &env(&[("HOME", "/u")]),
    )
    .unwrap();
    assert_eq!(r, "path//u/file");
}

#[test]
fn legacy_env_alongside_expr() {
    // Both forms in the same value.
    let r = resolve(
        "${HOME}/${{ env.NAME }}",
        &HashMap::new(),
        &env(&[("HOME", "/u"), ("NAME", "alice")]),
    )
    .unwrap();
    assert_eq!(r, "/u/alice");
}

// === bare stepId.output (legacy) ===

#[test]
fn bare_alias_resolves_to_text() {
    let o = outputs(&[("read", &[("text", "file body")])]);
    let r = resolve("read.output", &o, &HashMap::new()).unwrap();
    assert_eq!(r, "file body");
}

#[test]
fn bare_alias_unknown_step_errors() {
    let r = resolve("ghost.output", &HashMap::new(), &HashMap::new());
    assert!(matches!(r, Err(ExprError::UnknownStep(_))));
}

#[test]
fn bare_alias_only_matches_whole_value() {
    // `prefix read.output` — not a whole-string alias; passes through.
    let o = outputs(&[("read", &[("text", "x")])]);
    let r = resolve("prefix read.output", &o, &HashMap::new()).unwrap();
    assert_eq!(r, "prefix read.output"); // not substituted
}

// === interleaved literal + expr ===

#[test]
fn literal_text_passes_through() {
    let r = resolve("Hello, world!", &HashMap::new(), &HashMap::new()).unwrap();
    assert_eq!(r, "Hello, world!");
}

#[test]
fn multiple_expressions_in_one_value() {
    let o = outputs(&[("a", &[("text", "alpha")]), ("b", &[("text", "beta")])]);
    let r = resolve(
        "${{ steps.a.output }} + ${{ steps.b.output }}",
        &o,
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(r, "alpha + beta");
}

#[test]
fn unsupported_expression_errors() {
    let r = resolve("${{ secrets.API_KEY }}", &HashMap::new(), &HashMap::new());
    assert!(matches!(r, Err(ExprError::Unsupported(_))));
}

// === regression: $\{NAME} inside ${{ }} doesn't false-match ===

#[test]
fn env_regex_does_not_collide_with_expr_braces() {
    let o = outputs(&[("a", &[("text", "ok")])]);
    // The body of ${{ }} contains `.` which `\w+` won't match — verify
    // the env regex doesn't try to substitute pieces of the expression.
    let r = resolve(
        "${{ steps.a.output }} ${LEGIT}",
        &o,
        &env(&[("LEGIT", "yes")]),
    )
    .unwrap();
    assert_eq!(r, "ok yes");
}

// === substituted values are never scanned ===
//
// A `read-file` step's output is a document. Whatever it contains — text that
// looks like any reference form the resolver knows — is data, and must reach
// the next step byte for byte.

/// Values that look like references, plus the plain edge cases.
const REFERENCE_LOOKALIKES: &[&str] = &[
    "${HOME}",
    "${NOPE}",
    "${{ steps.a.output }}",
    "${{ steps.ghost.outputs.text }}",
    "${{ env.HOME }}",
    "${{ secrets.TOKEN }}",
    "const s = `Hello ${name}, total ${amount * 2}`;",
    "$$",
    "$$ E = mc^2 $$ costs $5 or ${5}",
    "ghost.output",
    "a.output",
    "",
    "路径 ${HOME} 与 ${{ env.HOME }} 都是正文",
    "first\r\n${HOME}\r\n${{ steps.a.output }}\r\n",
    "trailing dollar $",
    "unterminated ${HOME and ${{ env.HOME",
];

fn lookalike_env() -> HashMap<String, String> {
    env(&[
        ("HOME", "LEAKED-ENV-VALUE"),
        ("name", "leaked-name"),
        ("WHO", "alice"),
    ])
}

#[test]
fn a_step_output_reaches_the_next_step_byte_identical() {
    let e = lookalike_env();
    for text in REFERENCE_LOOKALIKES {
        let o = outputs(&[("a", &[("text", text), ("body", text)])]);
        for template in [
            "${{ steps.a.output }}",
            "${{ steps.a.outputs.text }}",
            "${{ steps.a.outputs.body }}",
            "a.output",
        ] {
            assert_eq!(
                resolve(template, &o, &e).as_deref(),
                Ok(*text),
                "template {template:?} with output {text:?}"
            );
        }
    }
}

#[test]
fn a_step_output_embedded_in_a_template_is_spliced_verbatim() {
    let e = lookalike_env();
    for text in REFERENCE_LOOKALIKES {
        let o = outputs(&[("a", &[("text", text)])]);
        let resolved = resolve("Summarize:\n${{ steps.a.output }}\n-- ${WHO}", &o, &e);
        assert_eq!(
            resolved,
            Ok(format!("Summarize:\n{text}\n-- alice")),
            "output {text:?}"
        );
    }
}

#[test]
fn an_env_value_is_never_scanned_either() {
    let o = outputs(&[("a", &[("text", "step text")])]);
    let e = env(&[
        ("LEGACY", "${HOME}"),
        ("EXPR", "${{ steps.a.output }}"),
        ("HOME", "LEAKED-ENV-VALUE"),
    ]);
    for (template, expected) in [
        ("${{ env.LEGACY }}", "${HOME}"),
        ("${LEGACY}", "${HOME}"),
        ("${{ env.EXPR }}", "${{ steps.a.output }}"),
        ("${EXPR}", "${{ steps.a.output }}"),
    ] {
        assert_eq!(
            resolve(template, &o, &e).as_deref(),
            Ok(expected),
            "template {template:?}"
        );
    }
}

#[test]
fn text_and_a_value_cannot_combine_into_a_reference() {
    // `$` from the template followed by `{HOME}` from a value spells `${HOME}`
    // only in the OUTPUT, which is never scanned.
    let e = env(&[("BRACED", "{HOME}"), ("HOME", "LEAKED-ENV-VALUE")]);
    let r = resolve("$${{ env.BRACED }}", &HashMap::new(), &e);
    assert_eq!(r.as_deref(), Ok("${HOME}"));
}

#[test]
fn a_bare_alias_is_decided_on_the_template_not_on_a_value() {
    let o = outputs(&[
        ("a", &[("text", "ghost.output")]),
        ("read", &[("text", "file body")]),
    ]);
    // A step whose whole output reads like an alias is not followed…
    let r = resolve("${{ steps.a.output }}", &o, &HashMap::new());
    assert_eq!(r.as_deref(), Ok("ghost.output"));
    // …and neither is an alias assembled from a substituted value.
    let e = env(&[("STEP", "read")]);
    let r = resolve("${STEP}.output", &o, &e);
    assert_eq!(r.as_deref(), Ok("read.output"));
}

#[test]
fn a_large_output_full_of_lookalikes_passes_through() {
    // 1 MiB of text shaped like references: one pass over the TEMPLATE costs
    // nothing per output byte beyond the copy, and changes none of them.
    let unit = "${HOME} ${{ env.HOME }} `${x}` $$ 中文\r\n";
    let text = unit.repeat((1024 * 1024) / unit.len() + 1);
    let o = outputs(&[("a", &[("text", text.as_str())])]);
    let r = resolve("${{ steps.a.output }}", &o, &lookalike_env()).unwrap();
    assert!(r == text, "a {}-byte output was altered", text.len());
}

// === the template itself still resolves, and still fails loudly ===

#[test]
fn a_template_mixing_every_reference_form_resolves_each() {
    let o = outputs(&[("a", &[("text", "T"), ("score", "9")])]);
    let e = env(&[("NAME", "alice"), ("DIR", "notes")]);
    let r = resolve(
        "${{ steps.a.outputs.score }}|${{ steps.a.output }}|${{ env.NAME }}|${DIR}|${{env.NAME}}",
        &o,
        &e,
    );
    assert_eq!(r.as_deref(), Ok("9|T|alice|notes|alice"));
}

#[test]
fn an_unknown_variable_in_the_template_still_errors() {
    // The output is full of resolvable-looking text; the TEMPLATE names a
    // variable that does not exist. That is still the author's mistake.
    let o = outputs(&[("a", &[("text", "${HOME}")])]);
    let e = env(&[("HOME", "LEAKED-ENV-VALUE")]);
    for template in [
        "${NOPE}",
        "${{ env.NOPE }}",
        "${{ steps.a.output }} ${NOPE}",
        "${NOPE} ${{ steps.a.output }}",
    ] {
        assert_eq!(
            resolve(template, &o, &e),
            Err(ExprError::UnknownEnv("NOPE".to_string())),
            "template {template:?}"
        );
    }
}

#[test]
fn the_leftmost_bad_reference_is_the_one_reported() {
    let r = resolve(
        "${NOPE} ${{ steps.ghost.output }}",
        &HashMap::new(),
        &HashMap::new(),
    );
    assert_eq!(r, Err(ExprError::UnknownEnv("NOPE".to_string())));
    let r = resolve(
        "${{ steps.ghost.output }} ${NOPE}",
        &HashMap::new(),
        &HashMap::new(),
    );
    assert_eq!(r, Err(ExprError::UnknownStep("ghost".to_string())));
}

#[test]
fn text_that_is_not_a_reference_is_left_alone_in_the_template() {
    // No value is involved: these never were references.
    for template in [
        "$$",
        "price: $5",
        "trailing $",
        "${}",
        "${ HOME }",
        "${HOME",
        "${{ env.HOME",
        "${a-b}",
        "",
    ] {
        assert_eq!(
            resolve(template, &HashMap::new(), &HashMap::new()).as_deref(),
            Ok(template),
            "template {template:?}"
        );
    }
}
