# ADR-004: Human-Oriented MCP Tool Design

> **Restored record.** This file was tracked as `dev-docs/decisions/ADR-004-human-oriented-mcp-tools.md` until commit
> `abc253488` moved `dev-docs/` out of version control. Everything under the rule below is that text,
> unedited: its Status line, paths and counts describe the tree as it was then, and the `dev-docs/…`
> files it cites are maintainer-local.
>
> **Enforced by** (checked 2026-10-02): superseded, so nothing enforces the design below. The tool surface that replaced it is defined in `server/mcp/src/bridge/operationSchemas.ts`, held by `pnpm lint:mcp-contracts` and `pnpm lint:mcp-docs`; the decisions behind it are in [plans/20260504-mcp-pruning.md](plans/20260504-mcp-pruning.md).

---

> Status: **Superseded** by `dev-docs/plans/20260504-mcp-pruning.md` | Date: 2026-01-22
>
> The hybrid 60-tool surface this ADR designed was replaced by the pruned
> 5-tool surface (`session`, `workspace`, `document`, `workflow`,
> `selection`). The introspection tools described below were folded into
> `session.get_state`; the granular formatting/structure/media/table tools
> were dropped on the basis that AI agents round-trip Markdown trivially;
> `selection.{get,set}` was retained per ADR-7 of the pruning plan because
> the full-doc round-trip is uneconomical on large files. Read this file
> for historical context only.

## Context

VMark's MCP tools (~60 tools) needed a design philosophy. The initial tools
mirrored the human editor interaction model: cursor positioning, selection
management, format toggling. This is **procedural and stateful** — each
operation depends on prior state (cursor position, selection). AI clients
struggled with this model because they think in terms of document structure and
transformations, not cursor navigation.

A redesign was needed to make MCP tools more effective for AI use while
remaining usable by humans.

## Considered Options

1. **Pure AI-oriented tools** — structural addressing, AST-level operations,
   declarative mutations. Drop cursor/selection concepts entirely.
2. **Hybrid: human-oriented base + AI introspection tools** — keep the existing
   cursor/selection model but add introspection tools so AI can understand
   document state before editing.
3. **Dual API** — maintain separate human and AI tool sets.

## Decision

Chosen: **Hybrid approach** (Option 2), because it preserves backward
compatibility while making AI workflows practical.

Changes made:

- Added 6 introspection tools (`editor_get_state`, `format_get_active`,
  `block_get_info`, `document_get_structure`, `document_diff_apply`,
  `batch_edit`) so AI can understand state in 1 call instead of 3-4.
- Removed 5 AI proxy tools that created recursive AI-calls-AI patterns.
- Deprecated `cursor_set_position` (redundant with `selection_set`).
- Kept all existing manipulation tools for human-oriented workflows.

## Consequences

- Good: AI can now introspect document state efficiently — single-call context
  gathering instead of multi-step cursor navigation.
- Good: Existing MCP clients continue working — no breaking changes to the
  manipulation API.
- Good: `batch_edit` and `document_diff_apply` enable atomic multi-site edits,
  reducing race conditions with concurrent user input.
- Bad: Tool count remains high (~60). Future simplification may consolidate
  tools further.
- Bad: The hybrid model means AI clients still need to understand cursor
  concepts for some operations, rather than working purely with structure.
