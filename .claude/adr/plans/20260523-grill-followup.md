# Decisions — Grill Report Follow-Up — Hardening From the 2026-05-23 Investigation

> Plan: `dev-docs/plans/20260523-grill-followup.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: follow-up hardening from the 2026-05-23 review.
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1: The adapter spike is dropped

**Decision:** Remove the report's P0 "spike runnable adapter contract" item. The contract lives at `src/lib/formats/types.ts` and downstream registry/adapters are already in `src/lib/formats/{adapters,registry.ts,extSync.test.ts}`.

**Mechanism:** The grill report's recommendation predated checking that file. Codex review caught it. Wasted work avoided.

**Confidence:** High.

### ADR-2: Persistence migration is the real Phase 1A blocker

**Decision:** Treat `hot_exit` schema migration for `format_id` / `editing_enabled` / `active_schema_id` as the gating work item for the multi-format Phase 1A.

**Mechanism:** Without versioned migration, the first multi-format release will silently corrupt or drop existing hot-exit sessions on upgrade. The data-loss surface is large (sessions can contain unsaved user content). The Codex review of multi-format plan rev 5 surfaced this as one of three High-severity findings.

**Confidence:** High.

### ADR-3: Reframe IME work as consolidation, not extraction

**Decision:** Instead of extracting an IME finite-state-machine from event handlers, **harden the existing `setupImeComposition.ts` module** by making its idle/composing/grace states explicit and exhaustively tested.

**Mechanism:** The grill report's recommendation assumed the IME logic was inlined. Live code shows it's already a module. The bug pattern (6+ recent fixes) reflects implicit state transitions inside that module, not the absence of one.

**Confidence:** High.

### ADR-4: Defer CI noise fix until next run

**Decision:** The `Claude Code` workflow's label step already has `|| true` at `.github/workflows/claude.yml:200`. Do not preemptively rewrite; observe the next run.

**Mechanism:** The failure source is upstream of the label step (the script that *checks* whether the label exists, run before the gh-cli step). Without a reproduction, a fix risks moving the failure rather than removing it. If the next run still fails, file a single targeted WI then.

**Confidence:** Medium — depends on next run behavior.

### ADR-5: Rust coverage is a separate tranche, not a gate

**Decision:** Rust coverage WIs (`workflow/runner.rs`, `hot_exit/storage.rs`, `mcp_bridge/server.rs`) run as Phase 3, parallel to Phase 4 cleanup. They do **not** block the multi-format gate.

**Mechanism:** Multi-format Phase 1A needs the menu matrix and persistence migration; it does not need broader Rust coverage. Coupling them would extend the gate by ~14 h for no causal reason.

**Confidence:** High.
