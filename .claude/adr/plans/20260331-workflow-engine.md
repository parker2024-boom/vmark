# Decisions — Workflow Engine: YAML Workflows + React Flow Visualization

> Plan: `dev-docs/plans/20260331-workflow-engine.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: workflow engine (first design).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1: React Flow for Workflow Visualization

**Decision:** Use `@xyflow/react` (React Flow v12) as the workflow canvas,
rendered in a side panel alongside the YAML source editor.

**Consequences:**
- Interactive from day one (click node to jump to YAML, hover for details)
- Partial re-renders (only changed nodes update during execution)
- Custom node components (progress bars, token counts, status icons)
- New dependency: `@xyflow/react` (~50KB gz), `dagre` (~15KB gz)
- Standard React component in a panel — no ProseMirror integration complexity

**Alternatives considered:**
- Mermaid-only: No click interaction, full re-render on change, no custom nodes
- React Flow in ProseMirror decoration: High risk (event isolation, lifecycle),
  eliminated by scoping to standalone `.yml` files only
- Vue Flow: VMark is React; wrong framework

### ADR-2: WorkflowGraph as Shared Model

**Decision:** All consumers (React Flow panel, static image export, execution
engine) consume a single `WorkflowGraph` data structure parsed from YAML.

**Consequences:**
- Single parser, single renderer, multiple surfaces
- Type-safe data flow between parser and renderer
- Source positions tracked per step for bidirectional editor linking

### ADR-3: Standalone .yml Files Only (No Code Fence Embedding)

**Decision:** Workflows are standalone `.yml` files, not YAML code fences inside
markdown documents. The visualization is a React Flow side panel, not an inline
code fence preview.

**Context:** Embedding React Flow inside ProseMirror widget decorations is the
highest-risk integration point — React Flow's drag/zoom/wheel events compete
with ProseMirror's event handling, the `Decoration.widget()` API expects passive
HTML, and the lifecycle management (React root mount/unmount during decoration
rebuild) is error-prone. Additionally, the `yaml workflow` language tag does not
round-trip through VMark's code block schema, which only preserves a single
`language` string.

**Consequences:**
- No ProseMirror integration risk — React Flow lives in a standard React panel
- No code block schema changes needed
- No `yaml workflow` language tag problem
- Simpler architecture: `.yml` file opens → CodeMirror + React Flow side panel
- Future: code fence preview can be added later as an incremental feature if
  there is demand, building on the proven side panel components

### ADR-4: GitHub Actions YAML Subset

**Decision:** Use a strict subset of GitHub Actions keywords for the workflow
spec. Familiar vocabulary, flatter structure, auto-exportable to real GHA.

**Kept:** `name`, `on`, `env`, `steps`, `id`, `uses`, `with`, `needs`, `if`,
`matrix`.

**Dropped:** `jobs`, `runs-on`, `container`, `services`, `permissions`,
`${{ }}` expressions.

**Added:** `limits` (timeout/cost/tokens), `approval` (show diff before
applying), `model` (override LLM model).

### ADR-5: Genie Spec v1 Extends Existing Frontmatter

**Decision:** Extend the current Genie frontmatter (which uses simple key:value
parsing) with typed input/output fields. Bump to `genie: v1` version marker.

**Context:** Current Genie metadata has `scope`, `action`, `model`, `context`.
The v1 spec adds `input.type`, `output.type`, `input.accept`, enabling
type-checking in workflows.

**Consequences:**
- Backward compatible: existing Genies without `genie: v1` continue working
- New fields parsed only when `genie: v1` is present
- Rust parser extended (not replaced) to handle nested YAML for input/output
- Adds `serde_yaml` dependency to Rust backend
