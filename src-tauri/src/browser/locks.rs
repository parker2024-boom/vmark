//! The browser's answer to a poisoned lock: refuse, and say so.
//!
//! Purpose: every piece of `BrowserSurface` state is authority — which tab may
//! act where, and on whose approval. A panic while one of its locks was held
//! may have left that state half-updated, so nothing is decided on it. A
//! command returns `ai_guards::lock_failure`; the WebKit delegate callbacks and
//! teardown paths have no error to return, so they go through these helpers,
//! which refuse AND log (`lock_policy::lock_or_refuse`). A refused navigation
//! or a revocation that could not run is therefore never silent.
//!
//! @coordinates-with lock_policy.rs — the crate-wide rule and the gate that enforces it
//! @coordinates-with browser/surface.rs — the state these locks guard
//! @module browser/locks

use super::ai_policy::AiBrowserPolicy;
use super::registry::BrowserRegistry;
use super::surface::BrowserSurface;
use crate::lock_policy::lock_or_refuse;
use std::sync::MutexGuard;

/// The lifecycle/identity registry, or `None` (logged) when it is poisoned.
pub(crate) fn registry(state: &BrowserSurface) -> Option<MutexGuard<'_, BrowserRegistry>> {
    lock_or_refuse(&state.registry, "the browser registry")
}

/// A copy of the AI policy, or `None` (logged) when it is poisoned.
pub(crate) fn ai_policy(state: &BrowserSurface) -> Option<AiBrowserPolicy> {
    lock_or_refuse(&state.ai_policy, "the browser AI policy").map(|policy| *policy)
}
