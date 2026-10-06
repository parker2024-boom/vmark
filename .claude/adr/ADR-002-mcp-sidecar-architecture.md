# ADR-002: MCP Sidecar Architecture

> **Restored record.** This file was tracked as `dev-docs/decisions/ADR-002-mcp-sidecar-architecture.md` until commit
> `abc253488` moved `dev-docs/` out of version control. Everything under the rule below is that text,
> unedited: its Status line, paths and counts describe the tree as it was then, and the `dev-docs/…`
> files it cites are maintainer-local.
>
> **Enforced by** (checked 2026-10-02): `pnpm lint:mcp-contracts` (`server/mcp/scripts/gen-mcp-contracts.ts --check`) holds the contract between the sidecar and the app; `pnpm test:sidecar` builds and tests the sidecar. The sidecar lives in `server/mcp/` today, not in the `vmark-mcp-server/` directory named below.

---

> Status: **Accepted** | Date: 2025-12-15

## Context

VMark needed to expose editor capabilities to external AI clients (Claude
Desktop, Cursor, etc.) via the Model Context Protocol (MCP). MCP servers are
typically long-running Node.js processes that communicate over stdio. Tauri apps
run a Rust backend — embedding a Node.js MCP server inside the Rust process was
not feasible without a JS runtime dependency.

## Considered Options

1. **Embedded MCP in Rust** — implement the MCP protocol directly in Rust.
2. **Node.js sidecar** — run a separate Node.js process that bridges MCP stdio
   to the Tauri backend via WebSocket.
3. **HTTP API** — expose a REST/GraphQL API from the Tauri backend, let AI
   clients call it directly.

## Decision

Chosen: **Node.js sidecar** (`vmark-mcp-server/`), because MCP's ecosystem is
JavaScript-first and a sidecar cleanly separates concerns.

Architecture:

- The MCP sidecar (`vmark-mcp-server`) handles stdio transport and tool
  registration per the MCP spec.
- A WebSocket bridge connects the sidecar to the Tauri backend
  (`src-tauri/src/mcp_bridge/`, a module directory), which manages port discovery and connection lifecycle.
- Read operations execute concurrently; write operations are serialized via a
  write lock to prevent race conditions.
- Port discovery uses a file in Tauri's app data directory — the sidecar reads
  this file to find the WebSocket endpoint.

## Consequences

- Good: Full MCP spec compliance with the official `@modelcontextprotocol/sdk`.
- Good: Sidecar can be developed, tested, and versioned independently of the
  Rust backend.
- Good: No Node.js runtime dependency in the main app — the sidecar is bundled
  as a Tauri sidecar binary.
- Bad: Extra process to manage — startup ordering, health checks, and zombie
  process cleanup (troubleshooting notes are inline in the module; the referenced `mcp-troubleshooting.md` was never written).
- Bad: WebSocket adds a network hop for every tool call. Mitigated by localhost
  communication (sub-millisecond latency).
