# Decisions — Plan: Coherence Runtime Layer — Verify-at-Volume, Classifier, Forward Operators, Canon-Hub, Merge Auditor

> Plan: `dev-docs/plans/20260719-coherence-runtime-layer.md` — written on the coherence runtime branch and never merged to `main` as a file.
> Built: the coherence runtime layer (`src-tauri/src/coherence/preview.rs`, `edge_kind.rs`, `merge_audit.rs`).
> Defines: ADR-P1, ADR-P2, ADR-P3, ADR-P4, ADR-P5. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-P1 — Dry-run projection is a pure candidate-overlay, mints nothing.**
  The one genuinely new kernel entry point. It overlays candidate revisions on
  the DAG and computes staleness/blast-radius *without appending to the ledger*.
  It reuses `dag::resolve`/`project_edge`; its correctness proof is **multiset
  observational equality over a disposable clone** (preview on a throwaway store
  vs commit-then-read on a second, envelope id/time/idem excluded; original
  byte-unchanged) — **not** the retired `commit → project → rollback` equality
  (append-only ⇒ no rollback). **Gated by SP1** (rule 60 §7). Traces: ADR-C6
  step 2, design D2.

- **ADR-P2 — Relationship-classifier placement resolved by SP3.** Only the
  **dependency/version** axis becomes an entry in a typed **`OriginEdgeKind`
  registry** — each kind carries `(origin: captured|discovered, shape:
  directional|symmetric, propagation: version|none)`. **Contradiction is NOT a
  registry entry** (G-B consistency #2): the semantic axis stays an `EdgeCheck`
  *assessment* that projection folds in (`project.rs:170-178`), never a kind. The
  registry is realized by the additive `edge_kind` slot (design v4.7). SP3
  decides kernel-level registry vs Tier-1 schema-pack declaration; recorded
  before Phase 2 commits.

- **ADR-P3 (re-cast) — Canon = claim-based, Context-hinged; surfaced through a
  conformance edge kind. No new atom, no object flag.** Per the owner decision,
  canon is **fed established claims in an enforcing Context** (paper §5;
  `claims.rs`/`contexts.rs`), *not* an "authoritative object" flag. Conformance
  is a registered `OriginEdgeKind` (directional, carries version-staleness)
  linking a conforming object to the canon it uses. Context-relative by
  construction (an alternate context may hold a `Diverged` canon). `Extract-Canon`
  and the typed candidate-effect model are deferred to SP-canon. Traces: paper
  §5, Deep-dive B, design owner-decision 1.

- **ADR-P4 — The auditor is composition, never a new algorithm, never an
  auto-merger.** ADR-C7 = run the existing checker over the edges a completed
  git merge touched (`merge_surface.rs` × `checker.rs`), surface contradictions
  for human resolution. No semantic object-merge is built (§14). Traces: R18,
  R11/R25, ADR-C7.

- **ADR-P5 — No new external dependencies.** Scope guard against rule 60 §4;
  any apparent need triggers a plan amendment + crate review, not a silent add.
