# Decisions — Plan: Coherence Layer — Kernel + Breakdown View (Phases 0–1, later phases outlined)

> Plan: `dev-docs/plans/20260718-coherence-layer.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the coherence kernel (`src-tauri/src/coherence/`).
> Defines: ADR-C1, ADR-C2, ADR-C3, ADR-C4, ADR-C5. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-C1 — SQLite via `rusqlite` (bundled).** Decide bundled vs. system
  SQLite in S2; default expectation: bundled (`rusqlite` `bundled` feature)
  for deterministic cross-platform behavior. New crate ⇒ manual review per
  rule 60 §4 (crates lack the npm heuristic) + `cargo audit`. **S2 PASS +
  recorded crate review are hard prerequisites to touching
  `src-tauri/Cargo.toml`** (Codex D3#4).

- **ADR-C2 — Workspace layout.** `.vmark/` at workspace root:
  `ledger/<writer-id>.jsonl` segments, `contexts/*.json` pin manifests,
  `snapshots/` CAS, `index.db` (gitignored), `waivers/` folded into ledger
  (waivers are ledger entries, not separate files — single append-only
  source). Final layout fixed in the format spec §1.

- **ADR-C3 — TDD mechanics for Rust kernel.** The `.claude/hooks/`
  TDD guard is TS-scoped; Rust kernel discipline is enforced by convention
  (tests-first in sibling `*.test.rs` modules via `#[path]` include) and by
  Phase DoD *running* the per-WI tests. Frontend WIs (breakdown view) fall
  under the standard coverage gate.

- **ADR-C4 — Kernel/service module boundaries (R22, Codex D1#5).**
  Within `src-tauri/src/coherence/`: **pure kernel** — `types.rs`,
  `canonical.rs`, `dag.rs`, `project.rs` (no I/O, no Tauri, unit-testable
  in isolation); **storage** — `ledger.rs`, `cas.rs`, `index.rs`
  (filesystem + SQLite, no Tauri types beyond errors); **services** —
  `scan.rs`, `capture.rs`, `gitops.rs`, `state.rs` (per-workspace kernel
  instance + serialization), `commands.rs` (Tauri surface). TypeScript
  consumes read models over IPC only (R27) and implements no kernel
  semantics. Every file ≤ 300 lines (repo gate).

- **ADR-C5 — New dependencies (rule 60 §4).** Exactly three additions,
  each requiring recorded review before its first commit:
  (1) `rusqlite` (bundled) — per ADR-C1/S2;
  (2) `uuid` **feature** `v7` (no new crate — feature add on the existing
  pinned crate) for entry/object/writer IDs;
  (3) `unicode-normalization` — NFC canonicalization (spec §3.1); tiny,
  no-deps, maintained by the unicode-rs org. No other new dependencies in
  Phases 0–1.
