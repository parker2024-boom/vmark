# Decisions — Browser hardening + E2E verification

> Plan: `dev-docs/plans/20260726-browser-hardening-and-e2e.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: browser hardening and the AI-browser E2E journeys (`e2e/`).
> Defines: ADR-BR1, ADR-BR2, ADR-BR3, ADR-BR4. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-BR1 — AI-browser E2E drives the **real sidecar over MCP stdio**

`AGENTS.md` mandates AI-driven features be tested through VMark MCP "exclusively — that
is the surface that ships". The existing harness (`e2e/lib/bridge.mjs`) speaks only the
Tauri bridge on 9323.

| Option | Tests | Rejected because |
|---|---|---|
| A. Raw WebSocket client to VMark's bridge | app-side handlers | Bypasses MCP initialize, tool-schema discovery, `tools/browser.ts` argument validation, and error transformation — all of which ship. |
| B. **Spawn the sidecar, speak MCP stdio** | sidecar + bridge + app | — |

**Decision: B**, with these implementation constraints (all from review):

- Use the MCP SDK's `Client` + `StdioClientTransport`. Do **not** hand-roll JSON-RPC.
  The framing is newline-delimited JSON, not `Content-Length`.
- Perform `initialize` + `notifications/initialized` before any `tools/call`.
- **Rebuild `dist` from the working tree every run.** Checking that `dist/cli.js`
  exists is not enough — the current one is dated July 19 and would silently test stale
  code. This is the single easiest way for this whole plan to prove nothing.
- Capture stderr separately; stdout is protocol-only.
- Poll for real bridge readiness before the first journey. `cli.ts` attempts the
  WebSocket connection *before* starting MCP stdio, so a stale-but-present port file can
  delay initialization by the full 10s connection timeout.
- Close stdin and reap the child in teardown.

**Honest scope limit:** `node dist/cli.js` exercises real sidecar logic but not the
`pkg`-built binary. This is not the literal "full shipping path" unless one smoke also
runs the packaged sidecar. Do not claim otherwise.

Timeout budget (verified, coherent): sidecar bridge request 25s
(`websocket.ts:64`) > MCP SDK client default 60s outer > browser wait input max 12s;
native main-thread cap 20s.

### ADR-BR2 — Approval journeys are **sequential**, not a held-open request

*(Corrected during drafting.)* `browserAct.ts:101-112` does **not** block. On
`needs-approval` it queues a prompt (`requestApproval` returns `void`) and immediately
responds. Approval later mints a one-shot via `grantSync.ts:106 →
browser_add_one_shot`; the **retry** consumes it. Four sequential steps, no concurrency.
The 25s bridge timeout is therefore irrelevant to approvals.

**Two consequences the first draft missed:**

- **The MCP boundary discards structured data.** `toErrorResult`
  (`tools/browser.ts:30`) renders the refusal as *text*, and `mcpAdapters.ts:171`
  returns only `content` + `isError`. A journey cannot assert `data.needsApproval`
  through MCP. It asserts the error text — and the **only** real proof that authority
  was minted is a **successful retry**.
- **"Assert `browser_add_one_shot` was minted" is not a valid oracle.** Reading the
  frontend store proves the frontend intended to mint. `grantSync.ts:106` fires
  `void invoke(...)` and swallows failure into a warning, so Rust may never have
  received it. Only the retry proves it.

### ADR-BR3 — Local fixture HTTP server; no public network

Journeys serve pages from `127.0.0.1`. Determinism, offline capability, and SSRF
assertions need destinations we control.

Fixtures must carry **oracles, not just pages**: per-endpoint request counters, distinct
DOM/server markers per action (click, back, forward, reload, stop), a slow endpoint, a
redirect endpoint, a private-IP redirect target, and clear-and-prove-absent endpoints
for cookies/localStorage.

### ADR-BR4 — Documentation is reconciled first (ordering, not a technical gate)

Phase 0 is first because it is ~20 minutes and fixes a live falsehood in the AI's
contract. The first draft called it a *gate* on later phases; on review that is
ceremony — prose edits do not technically unblock tests. It is ordered first on value,
not dependency.
