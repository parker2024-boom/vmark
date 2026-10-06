# Decisions — Plan: `open_workspace` MCP tool with approval gate

> Plan: `dev-docs/plans/20260721-mcp-open-workspace.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: MCP `workspace.open_folder` and its approval (`src/stores/workspaceApprovalStore.ts`).
> Defines: ADR-2, ADR-3, ADR-4, ADR-1. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-2 — Approval = fail-now → approve → AI-retry one-shot (rewritten; Codex F-03/F-04)

The browser flow does **not** wait-and-resolve. It queues a prompt and
**immediately** responds `success:false / APPROVAL_REQUIRED`
(`browserNavigation.ts:34`); the sidecar tells the AI to ask, wait, retry
(`tools/browser.ts:30`); "once" mints a token (`browserApprovalStore.ts:207`)
consumed by the **retried** handler (`browserAct.ts:101`). Holding the original
MCP call is impossible: a write-class request holds the global write lock and
times out at 10s/20s (`mcp_bridge/server.rs:497,574,663` — Codex F-04).

**Therefore:** `open_workspace` returns `APPROVAL_REQUIRED` immediately, minting a
one-shot bound to (canonical folder path, resolved window, **authenticated
client** — Codex F-10). The UI resolves store state; the AI **re-issues** the
call, which consumes the token and opens. **Denial** clears the pending item and
produces no later response — the retry fails closed. No handler ever awaits a
human.

### ADR-3 — Canonical directory validation (rewritten; Codex F-06)

`read_workspace_config` does **not** verify existence/dir-ness and can return
`None` (`workspace.rs:317`); `openWorkspaceWithConfig` opens with defaults even
on invoke failure (`openWorkspaceWithConfig.ts:90`). A real canonicalize+is-dir
validator exists but is private to window management
(`window_manager/path_validation.rs:34`). **WI-1.1a exposes a reusable
validation IPC** (or promotes that validator). Validate **before** prompting and
**again** immediately before consuming the token; the prompt and the token bind
to the **canonical** path so a symlink can't conceal the granted tree.

### ADR-4 — Window routing via `windowId`, not `windowLabel` (new; Codex F-05)

Rust routing recognizes `windowId` (`routing.rs:117`) and path fields
`workspace_root`/`filePath`, **not** `folderPath` (`window_routing.rs:21`). The
first draft's `{folderPath, windowLabel?}` would route to the focused/`main`
window regardless. WI resolves the target window via the router's `windowId`
contract, validates it, and binds approval + open to that **resolved** window
(sidebar reveal is webview-local — `workspaceCommands.ts:61`). Resolves OQ-1.

### ADR-1 — Shared helper **owns the transition guard** (amended; Codex F-08)

Extract `openWorkspaceByPath(path, { windowLabel })` from `workspaceCommands.ts`,
and make it **own (or require) the per-window `WORKSPACE_TRANSITION_GUARD`** — the
existing guard wraps picker + post-dialog work (`:43`); extracting only the
post-dialog lines would let an MCP call race menu open/close. Reuse the helper
from the non-dirty `workspace.openRecent` path too (duplicate sequence at
`recentWorkspacesCommands.ts:113`).
