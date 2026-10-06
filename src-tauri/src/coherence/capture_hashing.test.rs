// WI-RA11.4 — a capture canonicalizes its content once and hashes it once,
// and recording it that way changes nothing about what is recorded.

use super::*;
use crate::coherence::canonical::{
    hashing_counts, masked_text, reset_hashing_counts, text_content_hash,
};
use crate::coherence::state::WorkspaceKernel;
use crate::coherence::types::{AgentType, TypedBody, WriterId};

fn workspace() -> (tempfile::TempDir, WorkspaceKernel) {
    let dir = tempfile::tempdir().unwrap();
    let kernel = WorkspaceKernel::open(dir.path(), WriterId(uuid::Uuid::from_u128(5))).unwrap();
    (dir, kernel)
}

fn save(path: &str, content: &str) -> CaptureRequest {
    CaptureRequest {
        path: path.into(),
        content: content.into(),
        inputs: vec![],
        agent: Agent {
            kind: AgentType::Human,
            id: None,
        },
        intent: Intent {
            kind: "editor-save".into(),
            summary: "save".into(),
            prompt_hash: None,
        },
        confidence: Confidence::Exact,
        rewrite_identity: true,
        idem: None,
    }
}

/// CRLF line endings and a decomposed "é" (e + U+0301): both change under
/// canonicalization, so a capture that skipped it would record a different hash.
const RAW: &str = "# Cafe\u{301}\r\n\r\n笔记 🌍\r\n";

#[test]
fn a_capture_canonicalizes_and_hashes_its_content_once() {
    let (dir, mut kernel) = workspace();
    std::fs::write(dir.path().join("a.md"), RAW).unwrap();
    reset_hashing_counts();

    capture(&mut kernel, save("a.md", RAW)).unwrap();

    let (canonicalized, hashed) = hashing_counts();
    assert_eq!(canonicalized, 1, "the content is canonicalized once");
    assert_eq!(hashed, 1, "the content is hashed once");
}

#[test]
fn a_no_op_capture_also_hashes_once() {
    let (dir, mut kernel) = workspace();
    std::fs::write(dir.path().join("a.md"), RAW).unwrap();
    let first = capture(&mut kernel, save("a.md", RAW)).unwrap();
    let on_disk = first.content_with_identity.unwrap();
    reset_hashing_counts();

    let again = capture(&mut kernel, save("a.md", &on_disk)).unwrap();

    assert_eq!(again.entry_id, None, "identical content is a no-op");
    assert_eq!(hashing_counts(), (1, 1));
}

#[test]
fn hashing_once_records_what_hashing_the_raw_content_recorded() {
    let (dir, mut kernel) = workspace();
    std::fs::write(dir.path().join("a.md"), RAW).unwrap();

    let receipt = capture(&mut kernel, save("a.md", RAW)).unwrap();

    // The hash is identity-masked and canonical: the same value the raw
    // request content hashes to, identity block or not.
    let expected_hash = text_content_hash(RAW);
    assert_eq!(receipt.revision, RevisionId::compute(&expected_hash, &[]));
    let entries = kernel.ledger().read_all().unwrap().entries;
    let recorded = entries
        .iter()
        .find_map(|e| match e.typed().unwrap() {
            TypedBody::Transformation(t) => Some(t.outputs[0].content_hash.clone()),
            _ => None,
        })
        .expect("a transformation was appended");
    assert_eq!(recorded, expected_hash);
    // The snapshot holds exactly the masked canonical bytes (spec §4.2).
    let stored = kernel.snapshots().get(&expected_hash).unwrap();
    assert_eq!(String::from_utf8(stored).unwrap(), masked_text(RAW).bytes);
}
