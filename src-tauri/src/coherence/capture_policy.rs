//! The user's `general.coherenceCaptureOnSave` setting, as the kernel sees it
//! (WI-LX1.4).
//!
//! Every write-driven entry into the kernel — the `coherence_capture` IPC (human
//! save, MCP `document.write` / `workspace.save` / `workspace.save_as`, genie
//! apply, accepted AI
//! suggestion, history restore, explorer new-file) and the watcher-driven
//! `coherence_scan` — carries a `CapturePolicy`. The webview reads the setting
//! at the moment of the write and sends it with the request, so there is no
//! pushed copy that can lag behind the store.
//!
//! Key decisions:
//!   - **The kernel enforces it, not each caller.** Only the kernel knows whether
//!     the workspace already has a ledger, whether a path is already tracked, and
//!     whether an input must be adopted — and adoption is what stamped files the
//!     caller never named. A frontend-only check could see none of that.
//!   - **"Already has a ledger" means `.vmark/` is fully initialized ON DISK**
//!     (`is_fully_initialized`, the merge=union marker — never the kernel's
//!     cached flag, which goes stale; see `admits`).
//!   - **"Tracked" has one definition, and it is broader than "registered".**
//!     Under `TrackedOnly` a workspace that has a ledger keeps recording writes
//!     to TRACKED documents, where a document is tracked when EITHER its path is
//!     registered, OR its content already carries its own `vmark:` identity
//!     block. The second arm covers a tracked file that was moved, copied in or
//!     checked out at a path the registry has not seen: the watcher scan adopts
//!     exactly those documents (spec §9.4) without rewriting them, so refusing
//!     them here would only make capture disagree with the scan. Such a document
//!     is registered at its path the first time it is written — the one way the
//!     registry grows while the setting is OFF, and it needs no file to change.
//!     A document with NO identity at an unregistered path is never tracked.
//!     `TrackedOnly` never creates `.vmark/` and never rewrites any file.
//!   - An input that could only be resolved by stamping it is DROPPED and the
//!     capture's confidence falls to `inferred`: an input set known to be
//!     incomplete must not be reported as exact.
//!
//! @coordinates-with capture.rs — `capture_locked` applies the policy per step
//! @coordinates-with src/services/coherence/capturePolicy.ts — the webview side
//! @module coherence/capture_policy

use super::capture::{capture_locked, CaptureReceipt, CaptureRequest};
use super::frontmatter::read_identity;
use super::scan::scan_workspace;
use super::scan_report::ScanReport;
use super::state::WorkspaceKernel;
use super::workspace_files::is_fully_initialized;

/// What an implicit, write-driven capture may do to the workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapturePolicy {
    /// Setting ON: may create `.vmark/`, adopt new documents, and stamp
    /// `vmark:` identity blocks into files.
    Adopt,
    /// Setting OFF: in a workspace that already has a ledger, record writes to
    /// TRACKED documents only — registered at their path, or carrying their own
    /// `vmark:` identity (see the module doc). Create nothing, rewrite nothing.
    TrackedOnly,
}

impl CapturePolicy {
    /// May this capture rewrite a file on disk to insert an identity block?
    pub fn may_stamp(self) -> bool {
        self == CapturePolicy::Adopt
    }

    /// May an implicit write proceed against this kernel at all? Under
    /// `TrackedOnly` a workspace without a ledger is left exactly as it is.
    ///
    /// "Has a ledger" is read from DISK, never from the kernel's cached
    /// `is_initialized`: kernels are long-lived (one per workspace root), so the
    /// cache goes stale both ways. Stale-positive — the user deleted `.vmark/`
    /// while VMark ran — let an OFF-setting save recreate it; stale-negative —
    /// another writer initialized the workspace — declined documents that
    /// workspace now tracks. `capture_locked` runs `ensure_initialized`, which
    /// adopts the on-disk ledger without creating anything that exists.
    pub fn admits(self, kernel: &WorkspaceKernel) -> bool {
        self == CapturePolicy::Adopt || is_fully_initialized(&kernel.root().join(".vmark"))
    }
}

/// `capture` under the user's capture-on-save setting. `Ok(None)` = declined
/// by the policy with no side effect: no `.vmark/`, no registration, no file
/// rewritten.
pub fn capture_with_policy(
    kernel: &mut WorkspaceKernel,
    req: CaptureRequest,
    policy: CapturePolicy,
) -> Result<Option<CaptureReceipt>, String> {
    if !policy.admits(kernel) {
        return Ok(None);
    }
    locked(kernel, policy, |kernel| capture_locked(kernel, req, policy)).map(Option::flatten)
}

/// The lock a policy may take. `Adopt` may create `.vmark/`; `TrackedOnly`
/// takes the existing-only lock, which declines rather than create it — so a
/// `.vmark/` deleted between `admits` and the lock is not recreated.
fn locked<R>(
    kernel: &mut WorkspaceKernel,
    policy: CapturePolicy,
    f: impl FnOnce(&mut WorkspaceKernel) -> Result<R, String>,
) -> Result<Option<R>, String> {
    match policy {
        CapturePolicy::Adopt => kernel.with_write_lock(f).map(Some),
        CapturePolicy::TrackedOnly => kernel.with_existing_write_lock(f),
    }
}

/// Is the output TRACKED (module doc)? Under `TrackedOnly` only a tracked
/// document is captured: its path is registered, or its content carries its own
/// identity — which `capture_locked` then registers at this path.
pub(super) fn admits_output(
    kernel: &WorkspaceKernel,
    req: &CaptureRequest,
    policy: CapturePolicy,
) -> Result<bool, String> {
    // `capture_locked` canonicalized the content before asking, so a CRLF
    // identity block is still read as an identity block.
    if policy.may_stamp() || read_identity(&req.content).is_some() {
        return Ok(true);
    }
    Ok(kernel
        .index()
        .registry_state()?
        .object_at
        .contains_key(&req.path))
}

/// The watcher-driven reconciliation pass. Under `TrackedOnly` a workspace
/// without a ledger is not scanned: the pass's first append would create
/// `.vmark/`, and so would the lock (`with_existing_write_lock` declines). Nothing was reconciled, so the report is incomplete (and so can
/// never drive a deletion).
pub fn scan_on_change(
    kernel: &mut WorkspaceKernel,
    policy: CapturePolicy,
) -> Result<ScanReport, String> {
    if !policy.admits(kernel) {
        return Ok(ScanReport::default());
    }
    // The scan adopts identity-bearing files at unregistered paths under either
    // policy: they are tracked by definition (module doc), and adopting one
    // stamps nothing because the identity came from the file.
    Ok(locked(kernel, policy, scan_workspace)?.unwrap_or_default())
}

#[cfg(test)]
#[path = "capture_policy.test.rs"]
mod tests;
