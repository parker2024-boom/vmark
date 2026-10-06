//! The run as a step's `if:` condition sees it, and the three status functions
//! that read it (split from `condition.rs` at the file-size limit).
//!
//! | Function | True when |
//! |---|---|
//! | `success()` | no step has failed and every step this one `needs` completed |
//! | `failure()` | a step has failed |
//! | `always()` | always |
//!
//! Key decisions:
//!   - `success()` is the DEFAULT. A step with no `if:`, or an `if:` that names
//!     none of the three, runs only when `success()` holds: `if: X` means
//!     `success() && (X)`. That is GitHub Actions' rule, and it is what keeps a
//!     plain step from running on the failure path.
//!   - A step that was skipped (its own `if:` was false) blocks the steps that
//!     `needs` it without being a failure: `success()` is false for them and
//!     `failure()` stays false, so a failure handler never fires in a run where
//!     nothing failed.
//!   - A cancel is not something a condition can observe. The runner stops
//!     every remaining step before any condition is evaluated, so `always()`
//!     does not outlive the user's cancel.
//!
//! @coordinates-with condition.rs — evaluates the functions and applies the default
//! @coordinates-with runner.rs — builds the `RunStatus` each step is judged under
//! @module workflow::condition_status

/// What a step's condition can know about the run so far.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunStatus {
    /// A step before this one failed.
    pub failed: bool,
    /// A step this one `needs` did not complete — it failed or was skipped.
    pub blocked: bool,
}

impl RunStatus {
    /// What `success()` answers, and what a step that names no status
    /// function requires.
    pub fn succeeded(self) -> bool {
        !self.failed && !self.blocked
    }
}

/// A status function named in a condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StatusFn {
    Success,
    Failure,
    Always,
}

impl StatusFn {
    /// The function a bare operand spells, if it spells one.
    pub(super) fn parse(operand: &str) -> Option<Self> {
        match operand.trim() {
            "success()" => Some(Self::Success),
            "failure()" => Some(Self::Failure),
            "always()" => Some(Self::Always),
            _ => None,
        }
    }

    pub(super) fn evaluate(self, status: RunStatus) -> bool {
        match self {
            Self::Success => status.succeeded(),
            Self::Failure => status.failed,
            Self::Always => true,
        }
    }
}
