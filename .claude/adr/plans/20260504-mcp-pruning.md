# Decisions — MCP Pruning — Four Tools, Hard Cut

> Plan: `dev-docs/plans/20260504-mcp-pruning.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the pruned MCP tool surface (`server/mcp/`, `src/services/mcpBridge/v2/`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1: Drop in-document formatting tools entirely

**Decision:** Remove `format.*` (10), `media.*` minus CJK (9), `table.*` (3), `structure.*` (8), `selection.*` (5), `editor.{undo,redo,focus}`, `tabs.{reopen_closed, list_recent_files}`, and `document.*` mutation actions other than `read`/`write`/`transform` (insert, replace, replace_anchored, batch_edit, apply_diff, smart_insert, read_paragraph, write_paragraph, search).

**Mechanism:** AI agents round-trip Markdown text trivially. Bold is `**bold**`. Tables are pipe syntax. Sections are heading levels. Selections are derivable from full-doc reads. Every retained tool description costs context tokens (Anthropic engineering: tool definitions can drop from 150K to 2K via fewer-richer surfaces; GitHub MCP server alone is ~42K–55K tokens; tool-selection accuracy drops ~95% → ~71% with crowded surfaces). The strongest non-vendor signal — Armin Ronacher's "Code Is All You Need" — collapses Playwright MCP from ~30 tools to one.

**Confidence:** High. Industry convergence is unambiguous.

### ADR-2: Keep CJK formatting via `document.transform`

**Decision:** One new action `vmark.document.transform({kind: "cjk-format" | "cjk-spacing" | "cjk-punctuation"})` calls the deterministic CJK rewriter at `src/lib/cjkFormatter`.

**Mechanism:** CJK rules are rule-based and nuanced (full-width punctuation conversion, em-dash spacing per `AGENTS.md`, half/full-width handling). Unlike Markdown formatting, AI re-implementing CJK in prose is lossy and slow; the server-side rewriter is the reference implementation. One action, three kinds — extensible later (Markmap normalization, etc.) without adding tools.

**Confidence:** High.

### ADR-3: Drop `suggestions.*` (tracked changes)

**Decision:** Remove all 5 suggestion actions and the `suggestionHandlers.ts` handler.

**Mechanism:** User-confirmed: small user base on this feature; the read/write spine subsumes the producer flow (AI writes the proposed content directly), and the consumer flow is a UI-only feature.

**Confidence:** High.

### ADR-4: Optimistic concurrency on every mutation

**Decision:** Every mutation accepts `expected_revision`; mismatch returns `{error: "STALE", current_revision}`.

**Mechanism:** Without revision tokens, AI overwrites user keystrokes during async tool calls. The existing `revisionTracker` infrastructure in `src/hooks/mcpBridge/revisionTracker.ts` already exposes a per-document version counter — reuse it.

**Confidence:** High. Skipping this ships a data-loss bug.

### ADR-5: Expose `IRPatch` as the workflow patch contract

**Decision:** `vmark.workflow.apply_patch({patches: IRPatch[], expected_revision?})` accepts the existing discriminated union from `src/lib/ghaWorkflow/save/mutators.ts` (8 patch kinds: `workflow.set`, `job.set`, `step.set`, `with.set`, `with.remove`, `needs.add`, `needs.remove`, `trigger.setFilters`).

**Mechanism:** When the AI changes one field of an existing YAML, naive raw rewrite risks losing comments and anchors that the AI didn't bother to preserve in its output. The CST mutator path makes that loss structurally impossible — the server only touches the bytes that correspond to the patched key. Treat the discriminated union as `apply_patch_v1`; future breaking shape changes bump to `_v2`.

**Trade-off acknowledged:** Internal type becomes external contract. Mitigation: flag `IRPatch` in `src/lib/ghaWorkflow/save/mutators.ts` with an `@public` JSDoc so future renames trigger review.

**Confidence:** Medium-high. The patch shape has been stable through Phase 7+8+9 of the GHA viewer plan.

**What `apply_patch` does NOT replace:** `document.read` and `document.write` work on workflow YAML tabs (and every other tab kind). The pruned spine is universal:

- `document.read` returns raw YAML text + revision.
- `document.write` does a verbatim string replace; whatever the AI sends, that's what gets stored. Comments survive iff the AI's output preserves them.
- `apply_patch` is for the case where the AI is making a *targeted* change and the server should guarantee zero collateral edits to surrounding content.

There is deliberately no `workflow.read` (would duplicate `document.read` returning IR — AI parses YAML trivially) and no `workflow.write` (would be strictly worse than `document.write`, because IR-level serialization can't reconstruct comments that aren't in the IR).

### ADR-6: One-shot `session.get_state` replaces five discovery tools

**Decision:** Replace `get_capabilities` + `get_document_revision` + `tabs.list` + `workspace.{get_focused, list_windows, get_document_info}` with a single `vmark.session.get_state` call returning `{windows, capabilities}` with all open tabs and their `{id, filePath, dirty, revision, kind}`.

**Mechanism:** AI orientation typically takes 2–5 round-trips today (capabilities → focused → tabs → revision per doc). Folding into one response saves both wall time and tool-selection ambiguity. The `kind` discriminator (`"markdown" | "yaml-workflow"`) tells the AI which mutation tool applies.

**Confidence:** High.

### ADR-7: Reintroduce `selection.{get, set}` for large-file economics

**Decision:** Add a `selection` tool with two actions, `get` and `set`. Restores the read/replace-selected-text capability removed by ADR-1; does **not** restore the rest of the old `selection.*` family (`extend`, `clear`, range-only `set`). Date: 2026-05-08. Partial reversal of ADR-1.

**Mechanism:** ADR-1 assumed every edit goes through `document.read → reason → document.write`. That is economical on small docs and quadratic-feeling on large ones — every edit pays the full doc in input tokens, the full doc in output tokens (~5× input price), proportionally longer write windows that widen the stale-revision retry loop, and a faithfulness risk where the model silently rewrites untouched bytes under length pressure. `selection.get` cuts input cost to the selected range; `selection.set` cuts output cost to the replacement string. Restricted to the user-driven selection (no AI-side offset arithmetic), which sidesteps the stateful-procedural failure mode that motivated ADR-004.

**Shape:**

- `selection.get({tabId?})` returns `{text, isEmpty, range: {from, to}, mode: "wysiwyg"|"source", kind, tabId, revision}`. `text` is the markdown serialization of the selected slice in WYSIWYG mode, raw text in source mode. `range` is in PM positions (WYSIWYG) or character offsets (source) — `mode` disambiguates.
- `selection.set({tabId?, content, expected_revision?})` replaces the editor's current selection with `content`. In WYSIWYG mode, plain inline text inserts as a literal text node so leading/trailing whitespace round-trips exactly; content carrying markdown markers is parsed as nodes. In source mode, `content` is always spliced as raw text. `expected_revision` mismatch returns `STALE` with `current_revision`. Operates on the selection at call time — pure cursor movement between get and set is not arbitrated by the server (the doc-level revision catches keystrokes).

**Trade-off acknowledged:** Tool surface goes from 4 / 14 to 5 / 15. Two actions, not five — the surface-bloat penalty stays small. New error code `NO_EDITOR` covers the case where the focused tab has no live editor instance.

**Confidence:** High on the economics, medium on the surface-vs-capability balance. Revisit if AI clients start synthesising offset arithmetic on top of `selection.set`; that would be a signal to add `document.replace_range` rather than expand `selection.*`.
