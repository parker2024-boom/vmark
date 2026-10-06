# Decisions — The verified core — specification over accumulation

> Plan: `dev-docs/plans/20260802-verified-core.md` — a maintainer-local plan that was never tracked.
> Built: the verified Markdown core.
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

## ADR-1 — Verify in place first; extract only on evidence

### The finding

Revision 1 made package extraction Phase 1 and properties Phase 3. That order is
backwards, for three reasons discovered during review:

1. The nine app-local dependencies above mean extraction is not a move; it is a
   dependency-inversion project with two runtime registries in the way.
2. **A package boundary does not improve correctness.** It enforces a property
   the code should already have. Enforcement without the property is ceremony.
3. Properties can be written against the current code *today* — the existing
   property test proves the pipeline is Node-testable as it sits.

### Decision

Write the properties against the pipeline where it lives. Extract later, and
only when the ports work (Phase VC5) has actually removed the coupling.

Extraction remains the goal — purity enforced by `package.json` not listing
`react` is a guarantee that violation cannot bypass, where a lint rule only
detects violation after the fact. But it is the *reward* for decoupling, not the
mechanism of it.

**Explicit trigger for Phase VC6:** extraction proceeds when all nine app-local
dependencies are behind injected ports and the property suite is green against
the ported code. If that state is never reached, the properties still hold and
the plan has still delivered its value. Extraction is the optional part.

## ADR-2 — Markdown is the durable representation

> **Correction, rev 1 → rev 2.** Revision 1 asserted the ProseMirror doc was the
> durable representation and markdown its serialised form. **That is backwards**,
> and it invalidated the ADR built on it. Caught by Codex; verified independently.

### The finding

The authoritative content in `documentStore` is a **string**:

```ts
// src/stores/documentStore/documentState.ts
export interface DocumentState {
  content: string;
  savedContent: string;
  lastDiskContent: string;
  ...
}
```

The lifecycle is:

```
durable Markdown  ↔  live PM document  ↔  transient MDAST
```

- The editor **reconstructs** a PM doc from markdown at mount
  (`TiptapEditor.tsx` — the markdown→PM parse is deferred via `setTimeout` so
  the shell renders first).
- Every edit **serialises back** to a markdown string
  (`useTiptapFlush.ts` — `serializeMarkdown(editor.schema, editor.state.doc, …)`
  on a debounce).
- Rust hot-exit persists **string** content and markdown history checkpoints
  (`src-tauri/src/hot_exit/session.rs`).

MDAST is normally transient, though `parser.ts` and `proseMirrorToMdast.ts` do
export MDAST-returning functions from internal modules.

### Why this correction raises the stakes rather than lowering them

If markdown is durable and PM is a reconstruction, then **the round-trip runs in
production on every mount and every flush**. The fixpoint property is not an
academic nicety about a serialiser — it is the load-bearing invariant of the
application's core loop. A print/parse defect is not a bad export; it is silent
user data corruption on a debounce timer.

This also explains the four D1–D4 defects and why `softContentEquals` exists at
all (`documentState.ts` documents it as necessary because a strict compare "left
a CRLF doc dirty forever").

### Decision

Markdown is authoritative. PM is the live editing representation. MDAST is a
private implementation detail of parse/print and must not escape the codec.

A derived semantic projection (the knowledge-base direction) may be **edited**,
but only by compiling projection edits into revision-checked commands against
the markdown authority — stable IDs, precondition on revision, reject on stale.
It must never become a second authority.

**Reconsideration criteria.** This ADR is void, and the durable-representation
question must be reopened from scratch, if any of these becomes true:

- CRDT or real-time collaboration is introduced (markdown strings cannot carry
  the merge metadata; the CRDT becomes the authority by construction).
- Offline independent mutation of the projection is required.
- Markdown provably cannot express a construct the product needs, measured
  rather than asserted.

## ADR-3 — Zod at the trust boundary only

Zod belongs where untrusted bytes enter: file load, settings JSON, MCP payloads,
plugin manifests, workspace metadata. Parse once, at the edge, into a trusted
type.

Zod does **not** belong on internal domain types. It duplicates the TypeScript
types, costs runtime on hot paths, and gives false confidence — all that is
verified is that a value is well-shaped. "Parse, don't validate" means parse
*once*, not *everywhere*.

## ADR-4 — The generator is the asset

Random strings find nothing. Grammar-directed generation finds everything. The
existing property test already knows this, and its header states why its
generator is conservative: phrases from a fixed word list, constructs spaced so
they cannot touch, "so a stability failure is a real bug, not a generator
artifact around escaping/whitespace."

That was right for a first property. It is also exactly the constraint to relax,
one axis at a time, once totality properties make crashes visible.

### Decision

`generators/` is a first-class module, not test scaffolding. Target axes, in
rough order of expected yield:

- nested lists at depth ≥ 4, mixed ordered/unordered, loose vs. tight
- tables with pipes, escapes, and inline code inside cells
- CJK adjacent to emphasis — `**中文**中文`, the classic ambiguity
- footnote inside a table cell; HTML block inside a blockquote
- `$` inside code spans and fenced blocks; math adjacent to emphasis
- YAML frontmatter containing `---` inside a string
- CRLF, lone CR, tabs, trailing whitespace, zero-width characters
- combining marks, RTL runs, astral-plane codepoints
- reference links and definitions, including unresolved ones
- deliberately invalid markdown

Shrinking matters more than generation. fast-check's shrinker over a structured
arbitrary yields a minimal failing document — a three-line bug report instead of
a wall of noise. That is the difference between a property you act on and one
you mute.

## ADR-5 — Differential testing needs a shared observation, not a shared AST

> **Correction, rev 1 → rev 2.** Revision 1 said cross-parser differential
> testing was "not implementable" and titled itself "never remark." Too strong
> on both counts.

### The finding

The original proposal — parse with remark / markdown-it / micromark and compare
ASTs — fails for two reasons:

1. **AST equality is unsuitable.** mdast, markdown-it tokens and the VMark PM
   schema are incompatible node models.
2. **VMark already uses remark.** `adapter.ts` documents the pipeline as
   `markdown → MDAST (remark) → ProseMirror doc`. A differential test against
   the *same remark configuration* compares a thing to itself.

Neither makes differential testing impossible. Incompatible ASTs require a
**shared observation function** — a projection both sides can be rendered into.
An independent parser at a *different* configuration is still an independent
oracle.

### Decision

Three oracles, all real:

1. **Spec conformance** — CommonMark (652 machine-readable examples) plus the
   GFM extension spec, compared on **normalised HTML**.

   **Critical constraint:** the HTML must be rendered **from the resulting PM
   document**, not from remark's MDAST. Rendering MDAST directly bypasses the
   mdast→PM converters, which are the code under test and the code where D1–D4
   actually lived. A conformance suite that skips them is theatre.

2. **Independent parser** — `markdown-it` (a genuinely different implementation,
   not a differently-configured remark) via the same normalised-HTML
   observation. Divergence is a question, not a failure; VMark's deliberate
   deviations get an exception list with stated reasons.

3. **Characterization goldens across commits** — the corpus rendered at a known
   commit, re-rendered at HEAD, compared. This is the oracle that protects the
   Phase VC5 decoupling and the Phase VC6 move.

> **Correction, rev 1 → rev 2.** Revision 1's oracle 2 was "old pipeline vs. new
> core, both run over the generator." That is **structurally incoherent**: its
> first work item *moved* the pipeline, so after it there is no "old." Replaced by oracle 3,
> which is well-defined because goldens are commit-stamped artifacts rather than
> a second live implementation.

## ADR-6 — Observations, not one flattened abstraction

> **Correction, rev 1 → rev 2.** Revision 1's Phase 0 asked for
> `abs: (Doc, Selection) → (text, from, to)`. That is too lossy to serve as a
> model oracle.

### The finding

Two flat offsets cannot represent: marks and node attributes, table cell
structure, footnote identity and placement, `NodeSelection`, `AllSelection`,
code-block whitespace semantics, or math and media nodes carrying little or no
text.

Decisively, VMark ships a custom selection class —
`src/plugins/multiCursor/MultiSelection.ts:17`, `class MultiSelection extends
Selection`, with its own `SelectionBookmark`. A flat `(from, to)` cannot model it
at all.

Revision 1's stated failure mode — "if this cannot be written cleanly, the
schema is telling you something" — is not actionable. The schema is fine. The
abstraction was wrong.

### Decision

A **family of typed observations**, with different properties free to use
different members:

```ts
type SelectionObservation =
  | { kind: "text"; anchorPath: Path; anchorOffset: number;
      headPath: Path; headOffset: number }
  | { kind: "node"; path: Path; nodeType: string }
  | { kind: "all" }
  | { kind: "multi"; ranges: SelectionObservation[]; primary: number };
```

paired with a canonical semantic document projection. Property 3 (totality) needs
only "did it throw, is the doc valid" — no observation at all. Property 5
(history) needs the full selection observation. Forcing one abstraction to serve
both is what made revision 1's Phase 0 unbuildable.

## ADR-7 — Gate retirement requires evidence, not a target number

> **Correction, rev 1 → rev 2.** Revision 1 set "`check:all` step count strictly
> lower than 24" as a Definition of Done. That is Goodhart's law applied to my
> own plan — a target number substituted for the judgement it was meant to
> proxy. Struck.

### What survives

The narrow claim, which is defensible: **a gate that can be satisfied without
being correct manufactures confidence.** Coverage thresholds are the canonical
instance. `check:all` enforces them, and coverage is satisfiable by tests that
assert nothing.

Mutation testing is the check on that specific failure. Note that Stryker's
`"break": null` means it currently *reports* rather than *gates* — the `high: 85`
figure is a reporting band. Making it a gate is a deliberate, separate decision
with a CI-time cost.

### What is rejected

The claim that properties supersede the structural gates. They do not overlap: a
markdown round-trip property says nothing about design tokens, i18n
completeness, keybinding drift, shell slots or store coupling.

And for a solo maintainer whose principal collaborators are AI agents, cheap
structural gates have *unusually high* value, because agents reliably
reintroduce locally-plausible architectural regressions that a human reviewer
would catch by memory and an agent will not.

### Decision

Retire a gate only when all three hold:

1. The same invariant is enforced elsewhere, demonstrably.
2. Its catch history and false-positive history together justify removal.
3. Removal is scoped to that exact invariant, not to the script wholesale.

Reducing *wall-clock time* and command fragmentation is a legitimate goal.
Reducing the count is not.
