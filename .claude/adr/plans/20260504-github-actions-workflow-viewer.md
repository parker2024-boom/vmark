# Decisions — GitHub Actions Workflow Viewer & Editor

> Plan: `dev-docs/plans/20260504-github-actions-workflow-viewer.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: GitHub Actions workflow viewer (`src/lib/ghaWorkflow/`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7, ADR-8, ADR-9, ADR-10, ADR-11. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1: `@xyflow/react` v12 as renderer

**Decision:** Use `@xyflow/react` v12 (package `@xyflow/react`, not the
deprecated `reactflow` v11) for all interactive workflow visualization.

**Mechanism:** Custom node components are arbitrary React, so workflow nodes
can use VMark's design tokens, dark theme, popup classes. No competitor
(Reaflow, Cytoscape, Mermaid-with-CSS) gives this property.

**Cost:** ~50 KB gzipped. `dagre` or `elkjs` for auto-layout adds ~15-80 KB.
Default to `dagre`; offer `elkjs` lazy-loaded for workflows >50 nodes.

### ADR-2: WorkflowIR as the canonical pivot

**Decision:** A single typed structure (`WorkflowIR`) is produced from YAML
and consumed by every renderer.

```
                    ┌──▶ @xyflow/react graph (interactive)
                    │
YAML ──parse──▶ IR ──┼──▶ Mermaid text generator (.md export)
                    │
                    ├──▶ rendered DOM ──▶ SVG/PNG (image export)
                    │
                    └──▶ lint diagnostics (CodeMirror gutter)
```

**Consequences:** Mermaid export is reproducible from YAML alone — no runtime
dependency on the React Flow canvas being mounted. Lint diagnostics share
parse output with the renderer, so the gutter and the graph never disagree.

### ADR-3: One parser stack — `@actions/workflow-parser` for IR, `yaml` package for save-side CST

**Decision:** From Phase 1 onward, use `@actions/workflow-parser` (the official
GitHub-published parser, the same one that powers GitHub's own VS Code
extension and language server) to produce the IR. It returns a typed AST with
source positions, knows the workflow schema, and is the right granularity for
both read and lint paths. The `yaml` package (eemeli, ISC) is added in Phase 8
*solely* for the save-side CST that preserves comments and formatting.

**Mechanism:** `js-yaml` was originally proposed but rejected during Codex
review for two reasons: (1) it does not expose AST positions, so `SourceRange`
capture for click-to-jump and lint markers is impossible without a brittle
line-tracking layer, and (2) its `load()` rejects multi-document YAML by
default. `@actions/workflow-parser` was built for exactly this use case.

**Why split read and save:** the parser is optimized for reading and reporting
diagnostics — its AST is *not* a CST, so it cannot round-trip user formatting.
The `yaml` package's `Document` API is the inverse: lossy diagnostics, perfect
formatting preservation. They serve complementary roles. Phase 8 adds the
second parser; we never run *both* on the read path.

**Validation gate (per Phase 0 Spike A):** confirm that
`@actions/workflow-parser` exposes positions on every node we care about
(triggers, jobs, steps, `with:` keys). If a critical position is missing,
fall back to `yaml` package for read as well — accept the schema-awareness
loss in exchange for positions.

**Spike A result (2026-05-04):** PASS at 100% coverage across 7 fixtures
(7/7 root, 7/7 `on`, 16/16 jobs, 81/81 steps, 58/58 `with:` values, 1/1
matrix dim). Zero parser errors. The `yaml`-package read fallback is **not
required**.

**Runtime caveat:** the parser bundles a JSON schema via bare ESM JSON
import, which Node ≥22 strict ESM rejects without `with { type: "json" }`.
Vite handles this transparently in production. The Phase 1 acceptance test
must verify `parseWorkflow` works under Vitest (not just Bun).

### ADR-4: Code-fence preview is non-interactive; standalone files are interactive

**Decision:** Inside a markdown code fence, the workflow renders in `@xyflow/react`
**static mode** with the *full* interaction prop matrix disabled — not just
drag/zoom. An "Open in side panel" button promotes the same diagram into the
interactive standalone view.

The required prop matrix (verified by Phase 0 Spike C, not assumed):

```tsx
<ReactFlow
  panOnDrag={false}
  panOnScroll={false}
  zoomOnScroll={false}
  zoomOnPinch={false}
  zoomOnDoubleClick={false}
  nodesDraggable={false}
  nodesConnectable={false}
  nodesFocusable={false}
  edgesFocusable={false}
  elementsSelectable={false}
  preventScrolling={false}
  proOptions={{ hideAttribution: true }}
  /* keyboard focus stays with ProseMirror */
  tabIndex={-1}
/>
```

**Mechanism:** the original ADR claimed "static mode disables conflicting
handlers" but only listed four props. Codex correctly noted that scroll, focus,
selection, and keyboard-tab behaviors persist unless explicitly disabled. The
prop list above is the complete set; Spike C confirms none is forgotten before
Phase 3 commits.

**Spike C result (2026-05-04):** PASS at 9/10 scenarios. The full prop matrix
correctly disables zoom, pan, drag, focus capture, and lifecycle issues. The
single failure (mouse drag-select crossing the fence produces an empty PM
selection) has a known mitigation: scope `pointer-events: none` to the
canvas's `.react-flow__pane` and `.react-flow__viewport`, with
`pointer-events: auto` on `.react-flow__node`, `.react-flow__controls`, and
the "open in side panel" button. This lets drag-select pass through the
canvas while keeping clicks live. **Phase 3 WI-3.2 must include this CSS
and a regression test for scenario 9.**

The Mermaid-only fallback path is no longer needed — Spike C ruled it out.

### ADR-5: Detection heuristic — multi-signal, not just file path

**Decision:** "Is this YAML a GitHub Actions workflow?" is determined by:

1. **Path heuristic (high signal):** file under `.github/workflows/` and ends
   in `.yml` / `.yaml`.
2. **Shape heuristic (high signal):** parsed YAML has a top-level `on:` key
   AND a top-level `jobs:` key whose value is an object of objects.
3. **Code-fence info string (medium signal):** \`\`\`yaml or \`\`\`yml.
   Necessary but not sufficient — we still run the shape heuristic.
4. **Optional explicit info string:** \`\`\`yaml workflow renders unconditionally
   (escape hatch for ambiguous fences).

A YAML file that fails (1) and (2) is rendered as plain YAML — no surprises.

### ADR-6: Action-input discovery — lazy, cached, opt-in

**Decision:** `with:` field schemas are populated by fetching the referenced
action's `action.yml`. Fetch is lazy (only when the user opens the structured
editor for that step), cached for 24 hours in the Tauri config dir, and
respects an opt-out setting (`settings.workflowEditor.fetchActionMetadata: false`).

**Mechanism:** Without this, `with:` is free-form key/value — barely an editor.
With it, every `with:` field is typed and validated. The privacy/network cost is
real, hence opt-out + caching.

**Source priority:**
1. Local cache (`<tauri-config>/action-metadata/<owner>/<repo>/<ref>.json`).
2. `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/action.yml`.
3. Fallback: `action.yaml`. Fallback: `<path>/action.yml` for sub-action refs.
4. If all fail, render `with:` as free-form key/value with a "metadata
   unavailable" hint.

### ADR-7: Validation — official language services first, actionlint optional

**Decision:** Use the official GitHub-published packages (MIT, from the
`actions/languageservices` monorepo) for schema validation and expression
context typing:

- `@actions/workflow-parser` — already in use for the IR (ADR-3). Its
  `parseWorkflow` returns diagnostics directly; many lint findings come for
  free.
- `@actions/languageservice` — higher-level wrapper providing hover, completion,
  and validation suitable for editor integration.
- `@actions/expressions` — used internally by the others; pin in case we need
  direct evaluation for `if:` / `${{ }}` validation.

`actionlint` (Go binary, gold standard) is an *optional* second-layer
validator invoked via Tauri command if the user has it on PATH.

**Package-name correction:** the prior draft of this plan referenced
`@actions/languageservices` (plural) — that's the *repo* name, not a
publishable package. The npm names are singular (`@actions/languageservice`)
plus the per-component packages above. Confirmed via Phase 0 Spike A.

**Why both:** language services cover schema + expression types and run in the
browser. `actionlint` additionally catches script injection, glob mistakes,
runner-label typos, and shell-script issues — strictly richer, but Go-only.
Reimplementing actionlint in TS is out of scope.

### ADR-8: Three exports, three pipelines, one IR

**Decision:** Mermaid export is a pure function `(IR) -> string`. SVG/PNG
export uses `html-to-image` (`toSvg`, `toPng`) applied to the live React Flow
canvas DOM element — this is the official `@xyflow/react` v12 export pattern,
documented in their "Download Image" example. Both exports are user-invokable
via context menu; no implicit re-export on save.

**Package-name correction:** the prior draft assumed `ReactFlowInstance.toSvg()`
/ `toPng()` existed. They don't — `@xyflow/react` v12 has no built-in image
export. `html-to-image` is required as a separate dep.

**Tradeoff:** `html-to-image`'s SVG output wraps the DOM tree in
`<foreignObject>` rather than emitting native SVG primitives. This is fine for
docs/clipboard/email but renders inconsistently in some downstream contexts
(older PDF tools, embedded SVG in non-Chromium engines). For high-fidelity
vector export, a future v2 task could regenerate native SVG directly from the
IR. Not in v1 scope.

**Mermaid export is also lossy** (custom node decorations don't survive).
Surface both lossy paths in the UI: "Mermaid export omits run status, action
icons, and custom badges. SVG export uses foreignObject; for native SVG, use
PNG." Don't let lossiness be silent.

**Spike B result (2026-05-04):** PASS. `html-to-image` `toSvg` and `toPng`
both produce valid output from `@xyflow/react` v12 in light and dark
themes. Timings on a 20-node graph: SVG 44-48 ms, PNG 59-74 ms (well under
the 1500 ms threshold). CSS variables resolve to their computed values in
the export. **Caveat:** SVG outputs are large (~860 KB for 20 nodes due to
inline-style emission); a 100-node graph may produce ~3-4 MB SVGs. Phase
4 acceptance must test on a 100-node graph and decide whether to limit
SVG export to graphs below a threshold or document the size cost.

### ADR-9: ProseMirror integration mirrors `mermaid` plugin

**Decision:** Code-fence inline preview reuses the `mermaid` plugin's pattern:
a `NodeView` over `code_block` nodes, lazy-rendered when the language is
`yaml`/`yml` AND the shape heuristic passes, with a fallback `<pre>` if
detection fails or rendering throws.

**Mechanism:** `src/plugins/mermaid/index.ts` is 283 LOC and works. Don't
reinvent. The new plugin path is `src/plugins/githubWorkflow/`.

### ADR-10: Shared `WorkflowPanelShell` for both Genie and GHA features

**Decision:** Extract the split-pane shell (CodeMirror left + canvas right +
resize handle + persisted geometry) into a reusable React component
`src/components/Editor/WorkflowPanel/WorkflowPanelShell.tsx`. Both this plan
(GHA workflows) and `20260331-workflow-engine.md` (Genie workflows) mount
their own canvas content into the shell.

**Mechanism:** Codex flagged DRY risk between the two plans. The IRs and
parsers are genuinely different (GHA is full schema; Genie is a strict
subset), but the panel chrome is identical. Sharing the shell prevents two
divergent resize behaviors, two persistence schemes, two keyboard models.

**Routing:** A small detection layer (`src/lib/workflowRouting/router.ts`)
inspects the active file and decides which renderer to mount inside the
shell:

1. File under `.github/workflows/` AND parses as GHA workflow → GHA renderer.
2. File parses as Genie workflow (per `20260331-workflow-engine.md` rules) →
   Genie renderer.
3. Otherwise → no panel (plain YAML / plain markdown).

Detection priority is documented and tested. New: this routing layer is *also*
where the inline-fence detection lives, so both surfaces share precedence
rules.

### ADR-11: Round-trip gate — semantic + minimal-diff, not byte-identity

**Decision:** Phase 8's save-side acceptance gate is **not** byte-for-byte
equality. The realistic gate is the conjunction of:

1. **Comment preservation** — every comment present in the input file is
   present at the same logical position in the output.
2. **Anchor and alias preservation** — `&anchor` / `*alias` references survive
   round-trip without expansion or rename.
3. **Semantic equality** — `parseDocument(orig).toJS()` deep-equals
   `parseDocument(saved).toJS()`.
4. **Minimal diff** — for any IR-level edit affecting region R of the source,
   the byte-diff between input and output is contained in R ± its enclosing
   line. No whitespace-only or quoting-only changes outside R.

**Mechanism:** Codex correctly flagged that `yaml` package's `toString()`
normalizes some whitespace (trailing newlines, indentation of nested flow
collections) and quoting style. Demanding byte-identity would either fail on
trivial differences or force us to fork the stringifier. The four-condition
gate above is what users actually care about — comments, references, and "I
can still see what I changed in `git diff`."

**Tests** are written against this gate, with a fixture corpus producing one
golden output per fixture; deviations require manual review and the gate
re-baselines explicitly, never silently.

**Spike D result (2026-05-04):** PASS with stringify options
`{ lineWidth: 0, flowCollectionPadding: false }`. With these options, 4/7
fixtures round-trip byte-identically; the other 3 differ only in cosmetic
ways (1-line trailing-newline normalization, 1-line comment indent
normalization, and one fixture with a plain multi-line scalar that gets
collapsed to one line). All 7/7 preserve comments and anchors. All 21
edit scenarios (7 fixtures × 3 mutations) re-parsed without errors, with
all comments and anchors preserved.

**Project-standard stringify options** (export from `save/cstParser.ts`):

```ts
export const WORKFLOW_YAML_STRINGIFY_OPTIONS = {
  lineWidth: 0,
  flowCollectionPadding: false,
} as const;
```

**Documented v1 limitation:** plain (un-quoted, non-block-scalar) multi-line
strings get re-emitted on a single logical line. Affects ~5% of real-world
workflows. Mitigation (re-style as `>` block scalar before mutation)
deferred to v2 if user feedback demands.
