//! Copy-versus-move detection for adoption. Split from `adopt.rs`
//! for size.
//!
//! An identity-bearing file at a path the registry has not seen is either a
//! MOVE of the registered object (its old path is gone) or a COPY (the old path
//! still holds the same identity). Only a move may repoint the registry.
//!
//! @coordinates-with adopt.rs — `adopt_from_disk_locked` calls the check
//! @coordinates-with scan.rs — the scan's own duplicate-id diagnostic and hold
//! @module coherence/adopt_duplicate

use serde_json::json;

use super::frontmatter::read_identity;
use super::state::WorkspaceKernel;
use super::types::{Envelope, ObjectId};

/// A file carrying `object`'s identity at `rel_path` while the registry still
/// places `object` at a DIFFERENT path whose file exists and carries the same
/// identity is a copy, not a move (spec §2.1, I3). Registering it would silently
/// repoint the registry at the copy; instead surface a `duplicate-id`
/// diagnostic, capture-hold the object (as a scan would), and refuse. A held
/// object is refused outright, the same rule `capture_locked` applies.
pub(super) fn refuse_live_duplicate(
    kernel: &mut WorkspaceKernel,
    object: ObjectId,
    rel_path: &str,
) -> Result<(), String> {
    if kernel.index().is_held(&object)? {
        return Err(format!(
            "object {} is capture-held: duplicate vmark.id detected — resolve the duplicate files first",
            object.0
        ));
    }
    let registry = kernel.index().registry_state()?;
    let Some(prior) = registry
        .path_of
        .get(&object)
        .filter(|p| p.as_str() != rel_path)
    else {
        return Ok(());
    };
    match prior_still_holds(kernel, prior, object) {
        PriorPath::Gone => return Ok(()), // the original moved away: a move
        PriorPath::Unverifiable(why) => {
            // An original that EXISTS but cannot be read is not evidence of a
            // move: refuse rather than repoint the registry.
            return Err(format!(
                "cannot adopt {rel_path}: vmark.id {} is registered at {prior}, which exists but \
                 could not be read ({why}) — cannot tell a move from a copy",
                object.0
            ));
        }
        PriorPath::SameObject => {}
    }
    let env = Envelope::create(
        "diagnostic",
        kernel.writer(),
        json!({
            "code": "duplicate-id",
            "message": format!("objects at {prior} and {rel_path} share vmark.id {}", object.0),
            "path": rel_path,
        }),
    );
    kernel.append_and_apply(&env)?;
    kernel.index_mut().set_held(&object, true)?;
    Err(format!(
        "duplicate vmark.id {}: {rel_path} is a copy of {prior} — resolve the duplicate files first",
        object.0
    ))
}

/// What the registry's prior path for an object holds now.
enum PriorPath {
    /// Absent, or holding a different (or no) identity: the object moved.
    Gone,
    /// Present and still carrying the object's identity: a live duplicate.
    SameObject,
    /// Present but unreadable, so neither can be proven.
    Unverifiable(String),
}

fn prior_still_holds(kernel: &WorkspaceKernel, prior: &str, object: ObjectId) -> PriorPath {
    let abs = match super::paths::resolve_workspace_rel(kernel.root(), prior) {
        Ok(abs) => abs,
        Err(e) => return PriorPath::Unverifiable(e),
    };
    let bytes = match std::fs::read(&abs) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return PriorPath::Gone,
        Err(e) => return PriorPath::Unverifiable(e.to_string()),
    };
    // Not UTF-8 text: it cannot carry a `vmark:` block, so it is not this object.
    let Ok(text) = String::from_utf8(bytes) else {
        return PriorPath::Gone;
    };
    match read_identity(&super::canonical::canonicalize_text(&text)) {
        Some(fi) if fi.id == object => PriorPath::SameObject,
        _ => PriorPath::Gone,
    }
}
