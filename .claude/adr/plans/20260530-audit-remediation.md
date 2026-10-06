# Decisions — Audit Remediation — Dead Code, Optimization, Correctness & Hardening

> Plan: `dev-docs/plans/20260530-audit-remediation.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the 2026-05-30 audit remediation (boundary shape guards, dead code).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

**ADR-1 — Phase ordering is risk-first, not value-first.** Correctness bugs ship
before cosmetic cleanups even though cleanups touch more lines, because a CJK
export panic (P1) or orphan-document leak (C1) is user-visible and a regression
test locks it. Dead-code deletion is deferred to Phase 1 (after bugs) so a
revert during bug-fixing never tangles with large deletions.

**ADR-2 — Boundary validation is scoped, not universal.** T1/T2 flagged ~65
`invoke`/`listen` sites trusting typed payloads. We will **not** migrate all of
them to runtime schemas (over-engineering; the Rust side is the sole producer and
is test-covered). We validate only the **externally-driven or
highest-blast-radius** payloads: the MCP request stream (`mcpBridge`), workspace
config, AI response chunks, and session/hot-exit restore data. Everything else
stays typed-trust with a one-line note. Validators are hand-written shape guards
(no new `zod` dependency unless a payload is large enough to justify it).

**ADR-3 — `mcpBridge/utils.ts` is partially live; resolve per-symbol, not
per-file (corrected per Codex #2).** The file exports a **live `respond`**
(imported by `handleRequest.ts:20` + `v2/document.ts:57`) alongside helpers that
1C flagged dead and TQ2 flagged buggy (the emoji-offset `findTextMatches`).
WI-0.7 determines whether the v1 text-match helpers are still on any code path.
If the buggy helper is **live** → fix the offset + test (Phase 0). If **dead** →
delete it (Phase 1, WI-1.4). Either way `respond` (and any other still-imported
export) **stays**. There is no "delete the whole file" option.

**ADR-4 — Duplication refactors extract, then codemod, then delete — in one PR per
cluster.** Each shared helper (`errorMessage`, `wrapHandler`, `mediaExtensions`)
lands with its call-site migration and the old inline copies removed in the same
change, so the gate proves equivalence. The `errorMessage` codemod (126 sites) is
mechanical and reviewed as a single diff.

**ADR-5 — Bundle work is measured, not speculative.** B1/B2 savings are estimated
from `dist/` artifacts; before acting, each is confirmed with `pnpm size:why`.
B1 (mermaid `_` helper extraction) follows the documented-safe path (extract the
helper, do **not** re-split mermaid internals — prior attempts broke prod).

**ADR-6 — Accessibility changes mirror existing correct siblings.** A1
(ImageContextMenu) is rebuilt from the `TabContextMenu`/FileExplorer `ContextMenu`
templates (same CSS, proven pattern), not invented.
