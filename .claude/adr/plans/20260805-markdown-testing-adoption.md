# Decisions — Markdown testing adoption — harden the spec tier, close the editing-op gap

> Plan: `dev-docs/plans/20260805-markdown-testing-adoption.md` — a maintainer-local plan that was never tracked.
> Built: the Markdown spec, corpus and soak test tiers (`src/utils/markdownPipeline/__tests__/spec/`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-1: Exact delta signatures, not example-ID coverage.** A ledger entry
  must pin WHAT diverges (path/kind/observed-vs-expected, as
  `conformance/expectedDeltas.ts` already does), so a future different
  divergence on a declared example fails. ID-only coverage is a wildcard.

- **ADR-2: Per-corpus registry with explicit routes and oracles.** Each corpus
  declares which gates consume it and what its oracle is (stock-remark
  reference / expected VMark shape / roundtrip-only + dialect-node-produced
  assertion). No blanket delta families for knowingly-inapplicable oracles;
  no corpus list duplicated across test files.

- **ADR-3: Editing tests run the production stack.** Typing/fuzz harnesses use
  a real Tiptap `Editor` in jsdom with the production extensions and schema
  (`@/test/productionSchema`), driving `handleTextInput` / DOM keyboard events
  — never a hand-built snake_case schema (that is how the autoPair defect
  stayed invisible).

- **ADR-4: Independent ruler for roundtrip fidelity.** The fidelity leg parses
  both sides with VMark's own parser — blind to correlated parser/serializer
  defects. Add a stock-remark projected-tree comparison of input vs output
  (adopted from mdformat's render-both-sides oracle, in tree form — stronger
  than HTML equality; supersedes the earlier "redundant" rejection).

- **ADR-5: Ledgers and corpora are governed baselines.** Spec ledgers get
  identity ratcheting at the merge base (all verdicts, not just `defect`
  ceilings); corpus files get the OPPOSITE polarity (removal/mutation fails,
  addition is expected). Registration in `scripts/baselineRatchetManifest.mjs`
  is part of adding them (§11).

- **ADR-6: Soak work is a named tier, not an env var.** Anything over the PR
  budget (deep fuzz, full pathological sizes, OSS-Fuzz/Pro Git/editing-traces
  soaks) runs in an explicit vitest soak project + scheduled workflow with
  artifacts. NB `*.soak.test.ts` currently matches the default vitest include
  — the split must exclude it.
