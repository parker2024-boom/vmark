//! The read-time revision pin behind `coherence_head`.
//!
//! An MCP read records which revision the client was served, so a later
//! upstream edit is never attributed as the input of the client's next write.
//! The lookup runs ASYNCHRONOUSLY after the read, so "the current head" is not
//! evidence of what was read: a capture can land in between. The pin is
//! therefore PROVEN by content, or not made at all.
//!
//! Key decisions:
//!   - The served content is matched against the head's HISTORY, walked from
//!     the head backwards, so of several revisions with identical content
//!     (A → B → A) the most recent one on the current line wins — never
//!     whichever an index scan returns first.
//!   - Content matching no revision is an unsaved buffer. Its saved BASE (the
//!     tab's last-saved content) is matched the same way: that is the revision
//!     the buffer descends from.
//!   - When neither matches, the object is reported with `revision: null`:
//!     known, but no revision can be claimed. The webview then leaves the read
//!     out of the write's inputs. Leaving it merely UNPINNED would let the
//!     kernel resolve it to the head at write time — a revision the client
//!     demonstrably did not see.
//!   - Without content (legacy callers) the answer is the single head.
//!
//! @coordinates-with commands_ipc.rs — `coherence_head`
//! @coordinates-with src/services/coherence/mcpCapture.ts — the read tracker
//! @module coherence/head_pin

use std::collections::{HashSet, VecDeque};

use serde_json::json;

use super::canonical::text_content_hash;
use super::dag::RevisionDag;
use super::state::WorkspaceKernel;
use super::types::{ContentHash, ObjectId, RevisionId};

/// `None`: the path is not a known object, or its history is diverged.
/// `Some({object, revision})`: the pinned revision, `revision: null` when the
/// served content (and its base) match no revision on the head's history.
pub fn perform_head(
    kernel: &WorkspaceKernel,
    path: &str,
    served: Option<&str>,
    base: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let registry = kernel.index().registry_state()?;
    let Some(object) = registry.object_at.get(path).copied() else {
        return Ok(None);
    };
    let dag = kernel.index().load_dag()?; // ONCE: heads and the history walk
    let heads = dag.heads(&object);
    let [head] = heads.as_slice() else {
        return Ok(None);
    };
    let Some(served) = served else {
        return Ok(Some(json!({ "object": object, "revision": head })));
    };
    let mut revision =
        latest_with_content(kernel, &dag, &object, head, &text_content_hash(served))?;
    if revision.is_none() {
        if let Some(base) = base {
            revision = latest_with_content(kernel, &dag, &object, head, &text_content_hash(base))?;
        }
    }
    Ok(Some(json!({ "object": object, "revision": revision })))
}

/// The most recent revision on `head`'s history (breadth-first from the head)
/// whose content hash is `hash`.
fn latest_with_content(
    kernel: &WorkspaceKernel,
    dag: &RevisionDag,
    object: &ObjectId,
    head: &RevisionId,
    hash: &ContentHash,
) -> Result<Option<RevisionId>, String> {
    let mut queue = VecDeque::from([head.clone()]);
    let mut seen = HashSet::new();
    while let Some(rev) = queue.pop_front() {
        if !seen.insert(rev.clone()) {
            continue;
        }
        if kernel.index().content_hash_of(object, &rev)?.as_ref() == Some(hash) {
            return Ok(Some(rev));
        }
        queue.extend(dag.parents_of(object, &rev).unwrap_or_default());
    }
    Ok(None)
}
