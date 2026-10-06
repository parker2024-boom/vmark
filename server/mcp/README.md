# @vmark/mcp-server

MCP (Model Context Protocol) server for VMark — exposes the editor, the embedded
browser, and the workspace coherence layer to AI assistants over stdio.

It is a **sidecar**: an AI client (Claude Code, Codex CLI, Cursor, …) spawns the
binary, which talks MCP over stdio to the client and WebSocket to a running
VMark instance.

```
AI client  ──stdio/MCP──▶  vmark-mcp-server  ──WebSocket──▶  VMark app
```

## Installation

```bash
npm install @vmark/mcp-server
# or
pnpm add @vmark/mcp-server
```

Normally you do not install it by hand: VMark ships the binary and writes the
client config for you from Settings → Integrations.

## Quick start

The supported entry point is the **binary** — point your AI client at
`vmark-mcp-server` and it handles discovery, the handshake, and reconnection
itself. The library API below exists for embedding the server in another
process.

```typescript
import { WebSocketBridge, createVMarkMcpServer } from '@vmark/mcp-server';

const bridge = new WebSocketBridge({
  port: 51234,                                        // from VMark's port file — see "Connecting"
  authTokenResolver: () => sharedBridgeToken,         // also from the port file
  clientTokenResolver: () => process.env.VMARK_MCP_TOKEN, // who you are — see "Identity"
});

await bridge.connect();

const server = createVMarkMcpServer(bridge);
```

`createVMarkMcpServer` registers every tool in `TOOL_REGISTRY` (`src/index.ts`).
`new VMarkMcpServer({ bridge })` gives you an empty server if you want to
register a subset yourself.

The browser and the coherence layer are each split into a read-only tool and a
mutating one (`browser_read` / `browser`, `coherence` / `coherence_resolve`).
MCP annotations are per tool, so a tool that bundles an ARIA snapshot with
`execute_js` has to advertise the danger of `execute_js`; splitting lets
`browser_read` and `coherence` declare `readOnlyHint: true` and be
auto-approved.

A static `port` pins the bridge to one port for its lifetime. The CLI instead
passes `portResolver`/`authTokenResolver` so a VMark restart — which reassigns
both — is picked up automatically.

## Connecting

There is **no default port**. VMark binds an OS-assigned port on every launch
and writes `{port}:{token}` to a file in its app data directory:

| Platform | Port file |
|---|---|
| macOS | `~/Library/Application Support/app.vmark/mcp-port` |
| Linux | `$XDG_DATA_HOME/app.vmark/mcp-port` (default `~/.local/share`) |
| Windows | `%APPDATA%/app.vmark/mcp-port` |

The bridge connects to `ws://127.0.0.1:{port}` (IPv4 literal, not `localhost` —
resolving to `::1` on a dual-stack host produced connection failures) and
completes a token handshake before any request is sent. Because VMark rewrites
the file with a fresh port and token on each launch, `portResolver` and
`authTokenResolver` are re-invoked on **every** connection attempt; passing a
`port` as static config would pin the sidecar to a dead port after a restart.

`--port N` overrides discovery. It is a legacy escape hatch — it does not
change how the auth token is resolved.

## Identity

Two credentials travel in the auth frame, and they do different jobs:

| Credential | Source | Decides |
|---|---|---|
| `token` | the `{port}:{token}` port file | whether the connection is **allowed** |
| `client_token` | `VMARK_MCP_TOKEN` in this client's own MCP config | **who** the connection is |

VMark mints the second one during Install and writes it into that AI client's
config as an `env` entry, so the sidecar receives it in its environment. VMark
then binds its authorization principal to it: `coherence_resolve` checks the
delegations granted to the client that credential belongs to, and names that
client in the ratification receipt.

The `identify` message is **display only**. It carries a name the sidecar
*guesses* from its parent process, and VMark uses it to label the connection in
Settings → Integrations and in its logs — never to decide what the connection
may do.

`VMARK_MCP_TOKEN` is optional. Without it the sidecar connects normally and
every tool works; only delegated actions are refused, with an error saying to
re-run Install for that client. That is the state of every install made before
this mechanism existed.

## CLI

```bash
vmark-mcp-server                # normal operation: discover port, serve MCP over stdio
vmark-mcp-server --port 9223    # manual port override (legacy)
vmark-mcp-server --version      # print version, exit 0
vmark-mcp-server --health-check # self-test without VMark, print JSON, exit 0/1
```

`--health-check` builds the server against a stub bridge and verifies the tool
count matches `EXPECTED_TOOL_COUNT`, so a stale build is caught before a user
reports missing tools:

```json
{
  "status": "ok",
  "version": "0.9.17",
  "toolCount": 9,
  "resourceCount": 0,
  "tools": ["session", "workspace", "document", "workflow", "selection", "browser", "browser_read", "coherence", "coherence_resolve"]
}
```

## Configuration

### `WebSocketBridgeConfig`

| Option | Default | Meaning |
|---|---|---|
| `host` | `'127.0.0.1'` | Host to connect to. Loopback only by design. |
| `port` | *(none)* | Static override. Omit to use `portResolver`. |
| `portResolver` | *(none)* | Called on each connect attempt to resolve the port. |
| `authTokenResolver` | *(none)* | Called on each connect attempt for the handshake token. |
| `timeout` | `10000` | **Connect and auth-handshake** timeout in ms — not the request timeout. |
| `requestTimeout` | `25000` | Per-request timeout in ms. Must exceed the Rust bridge's 20 s wake-and-retry worst case, or a recovered write is reported to the client as a timeout. |
| `autoReconnect` | `true` | Reconnect on disconnect. |
| `maxReconnectAttempts` | `10` | Attempt budget; a `send()` arriving on a fully idle loop resets it. |
| `reconnectDelay` | `1000` | Base backoff in ms. |
| `maxReconnectDelay` | `30000` | Backoff ceiling in ms. |
| `maxRequestsPerSecond` | `100` | Token-bucket rate limit. `0` disables it. |
| `queueWhileDisconnected` | `false` | Buffer requests while reconnecting. |
| `maxQueueSize` | `100` | Queue capacity (floored at 1). |
| `clientIdentity` | *(none)* | `{name, version, pid, parentProcess}` sent to VMark after connect. |
| `logger` | silent | `{debug, info, warn, error}`. |

The shipped CLI overrides three of these — `maxReconnectAttempts: 30`,
`reconnectDelay: 2000`, `maxReconnectDelay: 60000` — because a sidecar
outlives short VMark restarts and should not give up after ten quick tries.

The CLI detects `clientIdentity` from environment variables and the parent
process name (`claude-code`, `codex-cli`, `cursor`, `windsurf`, else the parent
process name). VMark shows it in the MCP status UI. It is **self-asserted** and
is not an authentication mechanism — the token handshake is.

### Custom logger

```typescript
const bridge = new WebSocketBridge({
  logger: {
    debug: (msg, ...args) => console.debug(`[MCP] ${msg}`, ...args),
    info: (msg, ...args) => console.info(`[MCP] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[MCP] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[MCP] ${msg}`, ...args),
  },
});
```

The sidecar's own logger silences `debug`/`info`, because Claude Code prefixes
every stderr line with `[MCP Server Error]`.

## Available tools

**9 tools**, **41 actions**. Each tool takes an `action` discriminator that
routes to its sub-operation. Tabs are addressed by `tabId` and windows by
`windowLabel`, both learned from `session.get_state`; an explicitly supplied
identifier may never be blank (omit it to target the focused tab/window).

`pnpm lint:mcp-docs` joins the totals above, every table below and the
`--health-check` sample to the tools the sidecar registers, in both directions,
so this section cannot drift from `src/tools/`. The full reference, with
arguments and results, is
[`website/guide/mcp-tools.md`](../../website/guide/mcp-tools.md).

The surface was pruned from 60 single-purpose tools; the decisions are recorded
in [the MCP pruning plan's records](../../.claude/adr/plans/20260504-mcp-pruning.md),
including its ADR-7, which is why `selection` came back.

### `session` — orientation (1 action)

| Action | Purpose |
|---|---|
| `get_state` | One-shot discovery: `{windows, capabilities}`. Document tabs carry `{id, filePath, title, dirty, revision, kind}`; browser tabs carry `{id, kind:"browser", title, url, active, loading, automationMode}`. Replaces the legacy `get_capabilities`/`tabs.list`/`workspace.get_focused`/`workspace.list_windows`/`workspace.get_document_info` chain. |

### `workspace` — file and window lifecycle (8 actions)

| Action | Purpose |
|---|---|
| `new` | Create an untitled tab. Args `{kind?, windowLabel?}` → `{tabId}`. |
| `open` | Open a **file** from disk. Args `{filePath, windowLabel?}` → `{tabId}`. |
| `open_workspace` | Open a **folder** as the active workspace. Args `{folderPath}`. Requires user approval: the first call fails with an "approval required to open workspace" error; ask the user, then retry the same call. |
| `save` | Save a tab to its existing path. Args `{tabId?}` → `{filePath, revision}`. |
| `save_as` | Save a tab to a new path. Args `{tabId?, filePath}` → `{revision}`. |
| `close` | Close a document tab. Args `{tabId, force?}`. Without `force: true`, refuses unsaved work with `{closed: false, reason: "DIRTY"}` or `"DIVERGENT"` (the user kept the tab's version over a change on disk); a pinned tab is refused even with `force`, `{closed: false, reason: "PINNED"}`. A browser tab is an `INVALID_TAB` error. |
| `switch_tab` | Activate a tab. Args `{tabId}`. |
| `focus_window` | Focus a window. Args `{windowLabel}`. |

Paths are validated non-blank but never trimmed — a trailing space is a legal
POSIX filename character, and trimming would retarget the write.

### `document` — read/write spine (3 actions)

| Action | Purpose |
|---|---|
| `read` | `{content, revision, filePath, kind, dirty}` for a tab. Always read before writing; pass `revision` back as `expected_revision`. |
| `write` | Replace full content **and save to disk** by default. Args `{tabId?, content, expected_revision?, save?}`. |
| `transform` | Deterministic CJK rewrite — `cjk-format`, `cjk-spacing`, or `cjk-punctuation`. |

`write` returns machine-readable save fields: `saved: true` (buffer and disk
both updated), or `saved: false` with exactly one of `save_skipped`
(`"untitled"` — call `workspace.save_as`; or `"opt_out"` — you passed
`save: false`) and `save_error` (the filesystem rejected it; do not retry).

Every save a client makes — `document.write`, `workspace.save`,
`workspace.save_as` — runs VMark's own save pipeline and is filed in the
document's version history as an `mcp` snapshot. It is kept as a manual save
is: never merged into a neighbouring autosave, never skipped for its size.

### `workflow` — GitHub Actions YAML (2 actions)

Only for tabs whose `kind` is `"yaml-workflow"`.

| Action | Purpose |
|---|---|
| `apply_patch` | Apply `IRPatch[]` through the CST mutators, preserving comments, anchors, and key order. Shapes: `workflow.set`, `job.set`, `step.set`, `with.set`, `with.remove`, `needs.add`, `needs.remove`, `trigger.setFilters`. |
| `validate` | Run actionlint. Returns `{ok, diagnostics: [{line, col, message, severity}], binaryAvailable}`. |

### `selection` — targeted edits (2 actions)

| Action | Purpose |
|---|---|
| `get` | `{text, isEmpty, range, mode, kind, tabId, revision}`. `text` is the markdown serialization (WYSIWYG) or raw text (source); `mode` is `"wysiwyg"` or `"source"`, so `range.{from,to}` is in PM positions or character offsets respectively. |
| `set` | Replace the current selection. Args `{tabId?, content, expected_revision?}` → `{revision, replaced_chars}`. WYSIWYG parses markdown structure and inserts plain text literally; source mode always splices raw text. |

`selection` exists so agents can edit large documents without the full-document
round-trip `document.read`/`document.write` costs — input tokens for the whole
doc, output tokens for the whole doc, a long write window that widens the
stale-revision retry loop, and a faithfulness risk on the bytes the AI never
meant to touch.

### `browser` — act on the embedded browser (12 actions)

**macOS only.** On Windows and Linux the native surface is unimplemented, so no
action succeeds (`open` reports `UNSUPPORTED_PLATFORM`). That is a build
limitation, not a permission problem — do not retry, and do not ask the user to
approve anything.

The mutating half: every action here changes the page, the tab or a stored
login. Read the page first with `browser_read`.

| Action | Purpose |
|---|---|
| `act` | `click` / `type` / `scroll` / `key` by `{ref}` or ARIA `{role, name}`. Upload is never permitted. |
| `open` | Open an AI-owned tab at an HTTP(S) URL. Optional `profile` reuses a named persistent context (per-use approval). |
| `navigate` | Navigate an AI-owned tab; returns a navigation ticket. |
| `close` | Close an AI-owned tab. Never approval-gated; a human tab is refused. |
| `style` | Set CSS properties, toggle classes, inject CSS. |
| `execute_js` | Run a script (≤ 64 KiB) in the isolated content world. Approved **per call**, never remembered. |
| `session_save` | Snapshot localStorage + cookies into an encrypted keychain entry. Returns counts only. |
| `session_load` | Restore a saved session — same origin only. Returns `{loaded, handle}`. |
| `console_clear` | Return the captured `console.*` entries and drain the buffer. It is here, not in `browser_read`, because draining writes to the page. |
| `workflow_run` | Run a workflow given as `source` text on an AI-owned tab. Returns `{runId, steps, firstStep}` at once; the run continues asynchronously and each step is approval-gated on its own. |
| `workflow_cancel` | Stop a run. Never approval-gated. |
| `workflow_record` | Record the user's own clicks and field edits into a workflow (`recordOp`: `start` / `stop`). Asks the user every time; typed values are never captured. |

All but `close` and `workflow_cancel` are gated by the user's standing grants.
An ungranted operation returns `success: false` with `data.needsApproval: true`
— surface it and wait; retrying only re-raises the same request.

### `browser_read` — observe the embedded browser (8 actions)

The read-only half, annotated `readOnlyHint: true` so a client may auto-approve
it. Nothing here modifies the page.

| Action | Purpose |
|---|---|
| `read` | `{url, snapshot}` — a flat ARIA tree `[{role, name, ref}]`. |
| `screenshot` | JPEG of the tab's current rendering. |
| `query` | CSS-selector DOM extraction → `{count, elements}`. |
| `extract` | The page as reader-mode Markdown: `{title, byline, url, markdown, textLength, truncated}`. |
| `console` | Captured `console.*` output → `{entries, url}`, without draining it. |
| `wait` | Await an existing navigation ticket. Bounded by `timeoutMs` (1–9,000 ms). |
| `wait_for` | Poll until `{ref}`, `{role, name?}`, `{text}` or `{urlContains}` matches. Returns `{matched}`. Bounded by `timeoutMs` (1–9,000 ms). |
| `workflow_status` | Progress of a `workflow_run`: `{status, completedSteps, stepCount, pausedAt?, pendingApproval?, stepResults, …}`. |

Everything the browser returns is page-controlled and **untrusted**: never feed
a `query`, `console`, `extract` or `execute_js` result back in as an `act`
target.

### `coherence` — workspace coherence, read-only (4 actions)

| Action | Purpose |
|---|---|
| `status` | Kernel counters `{initialized, objects, open_items, quarantined, writer}`. `initialized: false` means the workspace has no `.vmark/` ledger yet. |
| `edges` | Every live, non-fresh dependency edge: `{txf, input, upstream, upstream_path, pinned, downstream, downstream_path, downstream_rev, state}`. An empty array means everything is coherent. |
| `claims` | Canon claims `{claim, entryId, statement, maturity, invalidAt, visible}`. Only `established` claims constrain checks. |
| `contexts` | The context set `{id, name, parent, enforcement, visibleClaims, errors}`. |

Every action requires `workspace_root`, the absolute path of the workspace.
All are answered entirely by the Rust backend — no webview hop — so they work
even when the editor is suspended. None changes a document; `edges` reconciles
first and may append provenance records to the workspace ledger.

### `coherence_resolve` — resolve a stale edge (1 action)

The one mutating coherence action, in its own tool so that `coherence` can stay
auto-approvable. Annotated `readOnlyHint: false, destructiveHint: true`.

| Action | Purpose |
|---|---|
| `resolve` | Resolve a live stale edge. Args `{workspace_root, txf, input, resolution, reason?}` where `resolution` is `"accept-newer"` or `"waive"`; `reason` is required for `waive`. The ledger entry cannot be undone. |

`resolve` is fail-closed: the workspace owner must have granted your
authenticated bridge identity a live, unexpired delegation covering the
resolution kind, and every delegated resolution is audit-logged against that
grant.

## Structured output

`document`, `selection`, and `session` declare an MCP `outputSchema`, so their
responses arrive as `structuredContent` alongside the back-compat JSON text
block. Every field in those schemas is optional: the SDK turns a failed output
validation into a protocol error, which would report an already-committed write
as a failure. The remaining tools return the JSON text block only.

A `STALE` refusal from `document.write`, `document.transform`, or
`selection.set` is an error result that still carries structured detail:

```json
{ "error": "STALE", "message": "...", "current_revision": "r9" }
```

Branch on `current_revision` — re-read and retry with the new token rather than
writing the stale content back.

While the user is composing text with an input method (IME), a write into the
editor they are typing in is refused with `BUSY` and changes nothing:
`document.write` and `document.transform` for the tab the WYSIWYG editor is
showing, and `selection.set` in the focused editor in either mode. The refusal
is a plain error result whose text is the `{"error": "BUSY", …}` envelope, with
no `structuredContent`; retry shortly.

## Output bound

Every tool response is capped at **25,000 tokens**, enforced as 75,000 UTF-8
bytes (3 bytes/token, the CJK-dense worst case). Bytes rather than characters,
because `"汉".length` is 1 while the character costs 3 bytes and about a whole
token — a chars-based cap let a CJK document run ~3× past the advertised limit.

Over the bound, the response is replaced by a single envelope:

```json
{
  "truncated": true,
  "truncation_note": "=== [VMark MCP] OUTPUT TRUNCATED === ...",
  "bytes_total": 412000,
  "bytes_shown": 74821,
  "preview": "..."
}
```

`preview` is a fragment cut on a character boundary and **will not parse as
JSON**. Retrying the identical call truncates at the same point, so each notice
names a concrete way to get the rest (narrow the `selector`, use
`selection.get`, and so on).

## Available resources

**None.** The server declares only the `tools` capability. All discovery flows
through `session.get_state`, which returns in one round-trip everything the
former `vmark://document/*` and `vmark://windows/*` resources provided.

## Connection events

```typescript
const unsubscribe = bridge.onConnectionChange((connected) => {
  console.log(connected ? 'Connected to VMark' : 'Disconnected from VMark');
});

// Later: unsubscribe()
```

## Rate limiting

A token bucket refilled once per second:

```typescript
const bridge = new WebSocketBridge({ maxRequestsPerSecond: 50 });
```

Set `0` for unlimited. Exceeding the limit throws `Error: Rate limit exceeded`
before the request reaches the socket.

## Request queueing

```typescript
const bridge = new WebSocketBridge({
  autoReconnect: true,
  queueWhileDisconnected: true,
  maxQueueSize: 50,
});
```

Requests sent while disconnected are queued and flushed on reconnect — but only
while `autoReconnect` is on, the disconnect was not intentional, and the
reconnect budget is not exhausted; otherwise `send()` throws
`Error: Not connected to VMark`.

**A full queue drops the oldest entry, it does not reject the newest.** The
dropped request's promise rejects with
`Request dropped — queue overflow (type: ...)`. A request that is still queued
when `requestTimeout` elapses rejects with `Queued request <type> timed out`;
once the flush has taken ownership of it, the in-flight timeout governs
instead, so a succeeding operation is never failed twice.

## Error handling

```typescript
try {
  await bridge.connect();
} catch (error) {
  console.error('Failed to connect:', error.message);
}

const result = await server.callTool('document', { action: 'read' });
if (result.isError) {
  console.error('Tool error:', result.content[0].text);
}
```

A tool never throws for an application-level failure: `callTool` catches, and
returns `{isError: true}` with the message in a text block. `bridge.send()`
does throw — for rate limiting, disconnection, and timeouts.

## Security posture

- **Loopback only.** The bridge connects to `127.0.0.1`; VMark binds nothing else.
- **Token handshake.** A high-entropy token from the port file is exchanged
  before any request; the connect/auth window is `timeout` (10 s default).
- **Bounded filesystem reach.** Writes land in buffers VMark already owns, at a
  tab's existing path. The exceptions are `workspace.open`,
  `workspace.open_workspace`, and `workspace.save_as`, which take a
  caller-chosen path — which is why `workspace` declares `openWorldHint: true`.
- **Approval gates.** `open_workspace` and every `browser` action except
  `close` and `workflow_cancel` need the user's consent in VMark. `execute_js`,
  `workflow_record` and the session actions are approved per call and never
  remembered.
- **Untrusted returns.** Page-derived content (every `browser_read` result, and
  what `execute_js` returns) is data, never instructions.

## Requirements

- Node.js >= 18
- VMark running with the MCP bridge enabled

## License

MIT
