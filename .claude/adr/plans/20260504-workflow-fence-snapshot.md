# Decisions — Workflow Fence Snapshot — xyflow inline render

> Plan: `dev-docs/plans/20260504-workflow-fence-snapshot.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: inline workflow-fence snapshot (`src/lib/ghaWorkflow/render/`, `src/plugins/codePreview/`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1: One IR, one renderer

**Decision:** Both surfaces — side panel and inline fence — feed the workflow IR into the same `toGraph` + `applyLayout` + `JobNode` pipeline. The inline path adds a final `html-to-image.toSvg()` capture step; the side-panel path keeps the live xyflow canvas.

**Mechanism:** Visual parity is structural rather than maintained by hand. Changes to `JobNode` (a new badge, a layout tweak) propagate to both surfaces automatically. Eliminates the "Mermaid emits boxes, side panel shows badges" divergence.

**Confidence:** High. Same approach the export pipeline takes (ADR-8 of the GHA viewer plan).

### ADR-2: Single shared off-screen xyflow root

**Decision:** Mount **one** persistent xyflow `ReactFlowProvider` + canvas at a fixed off-screen DOM position (e.g., `position: absolute; left: -9999px; visibility: hidden`). All snapshot renders re-use that same root by swapping nodes/edges via `setNodes`/`setEdges`. Don't mount one xyflow per code fence.

**Mechanism:** A markdown doc with 20 fences should not pay 20× the React mount cost. React's reconciler swaps node trees in-place much cheaper than mount/unmount. Bounded memory and main-thread cost regardless of doc size.

**Confidence:** High.

### ADR-3: Content-hash cache, in-memory + disk

**Decision:** Cache snapshots keyed on `hash(canonicalize(yaml))` where `canonicalize` strips comments and trailing whitespace. In-memory `Map` for the hot path; persisted to `appDataDir/workflow-snapshot-cache/<hash>.svg` (or a single JSONL with hash → SVG entries) so cold start has near-zero cost on unchanged docs.

**Mechanism:** Most repeated fences (tutorials, doc pages) are byte-identical or near-identical. Hash-cache turns N renders into 1 render + (N-1) lookups. Disk persistence turns repeat-session opens into (N-1) lookups.

**Confidence:** High on in-memory; **Phase 2** for disk cache (skip in v1 if MVP ships in budget).

### ADR-4: FIFO single-flight queue

**Decision:** Snapshot requests serialize through one queue. The shared xyflow root processes one workflow at a time: set nodes/edges, `await raf` for layout, `html-to-image.toSvg`, cache, advance. Concurrent calls wait their turn.

**Mechanism:** Concurrent renders contend for the layout pass and html-to-image's main-thread DOM walk; serializing eliminates contention without adding worker complexity.

**Confidence:** High.

### ADR-5: IntersectionObserver gating (Phase 2)

**Decision:** Only enqueue a snapshot job when the fence's placeholder is within ~1.5 viewport heights of the visible area. Off-screen fences stay as `code-block-preview workflow-preview--pending` placeholders until they near the viewport.

**Mechanism:** A long doc with 20 fences typically shows 1–3 at a time. Lazy-mounting fences when they near the viewport caps initial work to the visible window.

**Confidence:** Medium-high. Adds complexity; defer to Phase 2 if v1 already meets the perf budget.

### ADR-6: AI-side snapshot tool (deferred)

**Decision:** A future `vmark.workflow.snapshot({tabId})` MCP action could return the cached SVG, letting AI agents reason about the visual structure. **Not in v1 scope.** Recorded so the cache shape (workflow YAML → SVG) anticipates the use case.

**Confidence:** Low priority. Build only if real demand surfaces.
