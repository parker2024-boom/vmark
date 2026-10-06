// WI-RA14B.3 — a panic inside a locked workspace operation: it propagates
// unchanged, releases the cross-process lock, and leaves the kernel refusing
// every later operation until it is reopened — a ledger the panic may have
// left ahead of the index must never be built on.

use crate::coherence::state::WorkspaceKernel;
use crate::coherence::types::WriterId;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn writer() -> WriterId {
    WriterId(uuid::Uuid::from_u128(7))
}

fn panic_inside_the_lock(kernel: &mut WorkspaceKernel) -> String {
    let payload = catch_unwind(AssertUnwindSafe(|| {
        let _ = kernel.with_write_lock(|_| -> Result<(), String> { panic!("boom inside") });
    }))
    .expect_err("the panic propagates");
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .unwrap_or_default()
}

#[test]
fn a_panic_in_a_locked_operation_propagates_and_poisons_the_kernel() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut kernel = WorkspaceKernel::open(dir.path(), writer()).expect("open");

    assert_eq!(panic_inside_the_lock(&mut kernel), "boom inside");

    let reason = kernel.ensure_available().expect_err("poisoned");
    assert!(
        reason.contains("a panic escaped a locked operation"),
        "{reason}"
    );
    // Not the re-entrant branch: the next locked operation is refused
    // outright, and its body never runs.
    let mut ran = false;
    let refused = kernel.with_write_lock(|_| {
        ran = true;
        Ok(())
    });
    assert!(refused.is_err());
    assert!(!ran, "a poisoned kernel must not run work, locked or not");
}

#[test]
fn a_panic_releases_the_workspace_lock_for_other_kernels() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut first = WorkspaceKernel::open(dir.path(), writer()).expect("open");
    panic_inside_the_lock(&mut first);

    // A second kernel on the same workspace stands for another process: if
    // the panic had leaked the flock, this would block forever.
    let mut second = WorkspaceKernel::open(dir.path(), writer()).expect("open");
    let value = second.with_write_lock(|_| Ok(42)).expect("lock is free");

    assert_eq!(value, 42);
}

#[test]
fn reopening_after_a_panic_restores_the_workspace() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut kernel = WorkspaceKernel::open(dir.path(), writer()).expect("open");
    panic_inside_the_lock(&mut kernel);
    drop(kernel);

    let mut reopened = WorkspaceKernel::open(dir.path(), writer()).expect("reopen");

    reopened.ensure_available().expect("available again");
    assert_eq!(reopened.with_write_lock(|_| Ok("ok")).unwrap(), "ok");
}

#[test]
fn a_nested_locked_operation_runs_on_the_lock_already_held() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut kernel = WorkspaceKernel::open(dir.path(), writer()).expect("open");

    // Taking the flock again through a second descriptor would block this
    // thread on itself; the nested call must reuse the held one.
    let inner = kernel
        .with_write_lock(|k| k.with_write_lock(|_| Ok("inner")))
        .expect("nested");

    assert_eq!(inner, "inner");
}
