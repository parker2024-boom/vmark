// WI-RA14B.3 — `Envelope::typed()` rejects each malformed known kind with
// the reason that names its own defect. `envelope.test.rs` covers the edge
// coordinates and the cross-kind rules; these are the per-field refusals no
// test reached. Each body is valid except for the one field under test, and
// the exact message is asserted, so a refusal for some other reason (an
// earlier check firing) cannot pass for the one that is meant.

use crate::coherence::envelope::Envelope;
use crate::coherence::types::{Agent, AgentType, Confidence, Intent, Transformation, WriterId};
use serde_json::{json, Value};

const TXF: &str = "019f75b7-74f9-79f3-a00f-c426a7f6a462";
const OBJ: &str = "019f758b-af1f-7821-bd64-8c5e584cf25a";
const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn rejection(kind: &str, body: Value) -> String {
    Envelope::create(kind, WriterId(uuid::Uuid::from_u128(1)), body)
        .typed()
        .err()
        .unwrap_or_else(|| panic!("{kind} was accepted"))
}

fn accepted(kind: &str, body: Value) -> bool {
    Envelope::create(kind, WriterId(uuid::Uuid::from_u128(1)), body)
        .typed()
        .is_ok()
}

fn rev(c: char) -> String {
    format!("rev1:{}", c.to_string().repeat(64))
}

#[test]
fn a_transformation_with_no_outputs_is_rejected() {
    let body = serde_json::to_value(Transformation {
        inputs: vec![],
        outputs: vec![],
        agent: Agent {
            kind: AgentType::Human,
            id: None,
        },
        intent: Intent {
            kind: "test".into(),
            summary: "nothing".into(),
            prompt_hash: None,
        },
        confidence: Confidence::Exact,
    })
    .unwrap();

    assert_eq!(
        rejection("transformation", body),
        "transformation with no outputs"
    );
}

#[test]
fn a_flag_judgment_must_be_one_of_the_known_values() {
    let edge = json!({ "txf": TXF, "input": 0 });
    for judgment in [json!("Relevant"), json!(""), json!(1), Value::Null] {
        assert_eq!(
            rejection(
                "flag-judgment",
                json!({ "edge": edge, "judgment": judgment })
            ),
            "flag-judgment with an unknown judgment value",
            "{judgment}"
        );
    }
    assert!(accepted(
        "flag-judgment",
        json!({ "edge": edge, "judgment": "unsure" })
    ));
}

#[test]
fn an_edge_anchor_heading_may_be_neither_empty_nor_oversized() {
    let edge = json!({ "txf": TXF, "input": 0 });
    let max = crate::coherence::anchors::MAX_SEGMENT_BYTES;
    let at_limit = "a".repeat(max);
    // A multi-byte heading is measured in bytes, not characters.
    let cjk_over = "标".repeat(max / 3 + 1);

    for heading in [String::new(), "a".repeat(max + 1), cjk_over] {
        assert_eq!(
            rejection(
                "edge-anchor",
                json!({ "edge": edge, "headings": [heading], "anchored_hash": HASH })
            ),
            "edge-anchor heading is empty or too long"
        );
    }
    assert!(accepted(
        "edge-anchor",
        json!({ "edge": edge, "headings": [at_limit], "anchored_hash": HASH })
    ));
}

#[test]
fn an_object_lifecycle_needs_a_real_object_id() {
    for object in [json!("not-a-uuid"), json!(""), json!(7), Value::Null] {
        assert_eq!(
            rejection(
                "object-lifecycle",
                json!({ "object": object, "state": "frozen" })
            ),
            "object-lifecycle without a valid object id",
            "{object}"
        );
    }
    assert!(accepted(
        "object-lifecycle",
        json!({ "object": OBJ, "state": "frozen" })
    ));
}

#[test]
fn a_delegation_needs_a_delegate_id_and_an_array_scope() {
    let valid = || {
        json!({ "delegation": "d1", "expires": "2027-01-01T00:00:00Z",
                "delegate": { "id": "agent-1" }, "scope": ["ratify"] })
    };
    assert!(accepted("delegation", valid()));

    let mut no_delegate = valid();
    no_delegate["delegate"] = json!({ "name": "agent-1" });
    assert_eq!(
        rejection("delegation", no_delegate),
        "delegation missing delegate.id"
    );

    for scope in [json!("ratify"), json!({}), Value::Null] {
        let mut body = valid();
        body["scope"] = scope;
        assert_eq!(
            rejection("delegation", body),
            "delegation scope must be an array"
        );
    }
}

#[test]
fn a_check_result_needs_revision_ids_and_a_known_verdict() {
    let valid = || {
        json!({ "edge": { "txf": TXF, "input": 0 }, "pinned": rev('a'),
                "checked_against": rev('b'), "verdict": "contradiction" })
    };
    assert!(accepted("check-result", valid()));

    for key in ["pinned", "checked_against"] {
        let mut body = valid();
        body[key] = json!("rev1:short");
        assert_eq!(
            rejection("check-result", body),
            format!("check-result {key} is not a revision id")
        );
    }
    for verdict in [json!("maybe"), json!(""), Value::Null] {
        let mut body = valid();
        body["verdict"] = verdict;
        assert!(
            rejection("check-result", body).starts_with("check-result verdict invalid"),
            "an unknown verdict must not be read as one of the three"
        );
    }
}
