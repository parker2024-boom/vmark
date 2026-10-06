# Decisions — Forward Operators and the Semantic-Merge Auditor (design proposal)

> Source: `dev-docs/grills/coherence/forward-operators-proposal.md` — written on the coherence runtime
> branch (git commit `16ec61494`) and never merged to `main` as a file. The proposal's own status line
> reads: APPROVED (owner, 2026-07-19).
> Built: the coherence runtime layer's forward operators and merge auditor
> (`src-tauri/src/coherence/preview.rs`, `src-tauri/src/coherence/merge_audit.rs`); the implementation-level
> decisions are in [the runtime-layer plan](20260719-coherence-runtime-layer.md).
> Defines: ADR-C6, ADR-C7.
> They continue the ADR-C1 to ADR-C5 series of [the coherence-layer plan](20260718-coherence-layer.md).
>
> The text below is the proposal's own. The only edit is to the two headings, which read
> "D1 — Proposed ADR-C6: …" and "D2 — Proposed ADR-C7: …" in the source. Section numbers (§5, §14) and
> requirement ids (R1, I3) refer to the coherence paper and spec, which are maintainer-local.

## ADR-C6 — Forward operators (propose → preview → verify → commit)

**Context.** A forward operator turns coherence from an after-the-fact
auditor into a runtime a creator composes in. The risk is that it drifts
into autonomous exploration/auto-commit — the exact thing §14 rejects on
evidence (auto-propagation of belief revisions is only ~20% *accurate* — the
methods' success rate, not an edit base-rate; §3.3 law 5). The design keeps the
human as scheduler.

**Decision.** A forward operator is a **userland, schema-pack function**
(Tier-1 extensibility — data, not runtime code; Tier-5 code plugins stay
deferred) that emits a *candidate* changeset. Its lifecycle:

1. **Propose** — the operator produces one or more candidate object
   revisions in memory. Nothing is appended to the ledger.
2. **Preview** — the kernel computes the staleness/blast-radius projection
   of the candidate revisions against the viewing context, via a **pure
   dry-run** that overlays the candidates on the DAG without minting them.
   This is the one genuinely new kernel entry point; everything else reuses
   the breakdown machinery (§6.2/§9.2).
3. **Verify** — optional advisory semantic check (Phase 2b checker, R11/R25)
   over each candidate; surfaced, **never blocking** (I3, §14).
4. **Commit** — only on explicit human accept, the chosen candidate lands as
   an ordinary `transformation` (R1) with `intent.kind = "operator:<name>"`
   and confidence per its capture path (§8). Input roles follow R24.

**Invariants preserved.** The operator **never auto-selects** among
candidates and **never auto-commits** (I3). N candidates ⇒ the human picks;
the tool only makes each candidate's blast radius legible. AI-proposed
output is unverified until the human accepts — consistent with the finding
that model self-correction does not catch its own errors (verification must
be external).

**Traces.** R1, R2, R24, R33, I3; §5 (everything is schema + transformations
on atoms); §14 (non-goal boundary); Tier-1 extensibility; ADR-C4 (this lives
at the kernel/service boundary, kernel stays pure).

**Open / spike (rule 60 §7).** The dry-run projection over *uncommitted*
candidate revisions is an unverified kernel assumption: staleness projection
is pure over (origin edges, resolution records, context), but candidates are
not in the ledger DAG. A Phase-0-style spike must show the projection
composes cleanly over a transient candidate overlay before any WI commits.

**Non-goals.** No autonomous exploration or multi-candidate auto-evaluation
(§14). No runtime code-plugin surface (Tier-5 deferred). Operators do not
mutate history or bypass capture.

## ADR-C7 — Semantic merge is an auditor, not an auto-merger

**Context.** Git produces textually-clean merges that can be semantically
contradictory; §8 already names the opportunity ("the semantic merge auditor
git never had"). The tempting over-reach is automatic semantic 3-way *object*
merge. An earlier external design discussion proposed exactly that ("build
automatic semantic merge — the load-bearing wall"). The evidence rejects it:
automatic semantic propagation/reconciliation is unsolved (§3.3 law 5;
belief-revision literature; §14).

**Decision.** Do **not** build automatic semantic merge. Build the
**auditor**: a git merge/mutation is already captured as an `agent:git`
transformation (R18); after it, run the Phase-2b checker (R11/R25) over the
affected edges and surface any contradictions in the breakdown for **human**
resolution — accept-newer / revise / waive (R15). This is a composition of
shipped/planned pieces (git-mutation capture + check-result + breakdown), not
a new algorithm.

**Traces.** R18 (git mutation ⇒ transformation), R11/R25 (semantic staleness +
check schema), R12/I3/R15 (human resolves), §8, §14.

**Why the correction matters.** The auditor is the evidence-consistent form
of the "semantic merge" moat; the auto-merger is a mirage that would import
the belief-revision failure mode the whole design sidesteps. Recording the
rejection here so it is not re-proposed.
