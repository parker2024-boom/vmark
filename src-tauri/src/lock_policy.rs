//! What a poisoned `std::sync` lock means in this crate, in one place.
//!
//! Purpose: a lock is poisoned when a thread panicked while holding it. A
//! caller that answers that with `if let Ok(..) = m.lock()` — or `.ok()`, or a
//! `match` whose `Err` arm does nothing — drops its work without a trace: the
//! menu stops resolving clicks, a revocation is skipped, and nothing anywhere
//! says why. Exactly two answers are allowed:
//!
//!   - RECOVER, the crate default: `m.lock().unwrap_or_else(PoisonError::into_inner)`.
//!     Right wherever every write replaces the protected value whole or
//!     leaves it valid at each step, so a panic cannot have left it torn —
//!     a menu snapshot, a cache, a registry of independent entries.
//!   - REFUSE, loudly: [`lock_or_refuse`], or `map_err` into a command error.
//!     For state whose invariants a mid-update panic could break and whose
//!     consumers must not act on it: the browser's authority registry, the
//!     trusted-HTML grants, a coherence kernel. The refusal is logged at error
//!     level every time, so it can never be mistaken for "nothing to do".
//!
//! `lock_policy.test.rs` holds the gate that keeps the silent shapes out of
//! the production tree.
//!
//! @module lock_policy

use std::sync::{Mutex, MutexGuard};

/// The guard, or `None` with an error logged when `mutex` is poisoned.
///
/// `what` names the state in the log line; it is always a literal chosen at
/// the call site, never text from outside the process.
pub(crate) fn lock_or_refuse<'a, T>(mutex: &'a Mutex<T>, what: &str) -> Option<MutexGuard<'a, T>> {
    mutex
        .lock()
        .map_err(|_| {
            log::error!(
                "[lock] {what} is poisoned (a thread panicked while holding it); refusing to use it"
            );
        })
        .ok()
}

#[cfg(test)]
#[path = "lock_policy.test.rs"]
pub(crate) mod tests;
