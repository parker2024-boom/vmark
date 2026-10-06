# Decisions — Slidev Support + Knowledge-Base Content Server

> Plan: `dev-docs/plans/20260624-1500-slidev-kb-content-server.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the knowledge-base and Slidev content server (`server/content/`, `src-tauri/src/content_server/`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-9, ADR-10, ADR-7, ADR-8. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1 — One bundled Node "content server" hosts both KB and Slidev

**Decision:** A single Node process (spawned by VMark's Rust backend, scoped to
the focused workspace) hosts both the KB site and the Slidev dev server.

**Rationale:** VMark's `remark` pipeline runs in Node; Slidev is Node. Reusing
one runtime avoids a second heavy dependency tree and a second lifecycle.
The KB renderer can reuse the exact remark plugins (`wikiLinks`, alerts,
details, math, gfm, frontmatter) from `src/utils/markdownPipeline/`.

**Consequence / fallback:** The KB core (index, render, search, graph) depends
only on lightweight Node deps and must function **without** the heavy Slidev
tree present. Slidev is a lazily-provisioned add-on: if Slidev isn't installed,
KB features still work; opening a Slidev deck prompts provisioning.

**Alternatives rejected:** Rust HTTP server (axum) — would require
reimplementing the entire remark pipeline + custom plugins in Rust; rejected.
Two separate Node processes — double the lifecycle/port management; rejected.

### ADR-2 — Runtime provisioning: signed in-bundle Node + two signed, version-pinned JS bundles, NOT `pkg`

**Canonical model (one model, no ambiguity):**

1. **Node runtime** (≥ **20.12** — Slidev's floor; do NOT inherit the sidecar's
   Node 18) ships **inside the app bundle and is codesigned by us**. Never
   downloaded.
2. **Two separate JS bundles**, each a pre-built, version-pinned, per-OS tarball
   we host:
   - **Base KB bundle** — Hono + the headless renderer + index/graph deps.
     Small. May ship in-app or download-on-first-use (decide in S0.5 once sized).
   - **Slidev bundle** — the full `@slidev/cli` Vite tree. Large.
     **Download-on-first-use only**, the first time a Slidev deck is opened.
3. **Chromium** (`playwright-chromium`) — separate provisioning on first
   *export* (Phase 7), never bundled.

**Downloaded JS is treated as executable code, not "inert" (corrects the earlier
overconfident claim):** `node_modules` can contain postinstall artifacts, native
addons, and helper binaries. Therefore: (a) we build the tarballs ourselves in
CI from a pinned lockfile (no live `npm install` on the user's machine →
sidesteps governance rule 4's slopsquatting risk); (b) each tarball carries a
**signed manifest** (checksum + version), verified before extraction; (c) the
build **bans native addons / executable payloads** unless individually
justified and signed; (d) on macOS the extracted tree is placed in app-data and
the quarantine xattr handled explicitly (validated in S0.5). We sign the
*manifest*, not each file, and gate execution on manifest verification.

**Rationale:** `@yao-pkg/pkg` cannot package Slidev's Vite toolchain (§1.2). A
signed in-bundle Node keeps the only native executable under our notarized
signature; pinned CI-built tarballs make the JS reproducible and
integrity-checkable without live registry resolution.

**Consequence:** Installer stays small (Node binary only); KB works as soon as
the small base bundle is present; first Slidev use incurs a one-time large
download with a clear, actionable prompt (offline → KB still works, Slidev
deferred). Provisioning is a state machine (see Phase 1 WI-1.1).

### ADR-3 — Slidev is rendered by Slidev (programmatic `createServer`), never VMark's pipeline

**Decision:** Use `@slidev/cli`'s programmatic API:
`createServer(resolveOptions({ entry }, 'dev'), …)` → a Vite `ViteDevServer`
VMark controls (`listen`/`close`/`restart`). Preview = load
`http://127.0.0.1:<port>` in a Tauri webview panel and/or external browser.

**Rationale:** Verified API; gives lifecycle control without fragile CLI
subprocess scraping. Slidev markdown is a Vue/Vite dialect that VMark's
remark→ProseMirror pipeline cannot and should not approximate.

**Uncertainty:** Vite `middlewareMode` to fold Slidev under the KB server's port
is **not a documented Slidev path** → spike S0.2 verifies; default to a separate
sub-port if middleware mode is unreliable.

### ADR-4 — KB HTML rendered headlessly (remark → rehype), diagrams client-side, math server-side

**Decision:** Build a Node headless renderer: reuse VMark's remark plugins to
produce MDAST, then `remark-rehype` + custom rehype handlers for VMark's custom
nodes (wiki-links, alerts, details, sub/superscript) → HTML. KaTeX renders
server-side (`katex.renderToString`); Mermaid/Markmap render **client-side** in
the served page (ship their browser bundles), mirroring how the editor does it.

**Rationale:** Decouples KB rendering from the Tiptap editor (which is
webview-coupled via `ExportSurface.tsx`). The remark *parser* plugins are pure
JS and portable to Node.

**Caveats surfaced by review (do not assume drop-in reuse):**
- **Not all semantics live in remark.** Alert blocks (and similar) are converted
  in the **MDAST→ProseMirror** step (`mdastToProseMirror`), not in a remark
  plugin. The headless path needs its *own* MDAST→HTML handlers for those nodes
  — they cannot be lifted from the ProseMirror conversion. Inventory every
  custom node's conversion site in S0.4.
- **Package boundary required.** `markdownPipeline` uses TS path aliases and
  editor-oriented preprocessing. Extract a Node-safe entry (a `markdownPipeline`
  package/subpath export with no `@/` aliases, no DOM, no editor imports) and
  prove it with a Node-only smoke test **before** building KB routes.
- **Sanitizer needs a DOM in Node.** The existing `src/utils/sanitize.ts` is
  browser-`DOMPurify`-coupled and degrades without `document`. The Node renderer
  must run DOMPurify atop `jsdom` or `happy-dom` (dependency decided in S0.4 /
  Phase 3), and the **same XSS corpus** must pass in both Node and browser.

**Consequence:** Custom rehype handlers + a Node sanitizer setup are net-new and
must be fidelity-tested against the editor's rendering (Phase 3 fixtures).

### ADR-5 — Relationship graph is a Node-built bidirectional index

**Decision:** The index walks the workspace (honoring `workspace.rs` exclude
rules + trust), parses frontmatter with `yaml` (already a dep), extracts:
(a) wiki-links resolved to files, (b) markdown links, (c) tags (`#tag` +
frontmatter `tags:`), (d) explicit frontmatter relations (configurable keys,
e.g. `related:`, `up:`, `links:`). It builds bidirectional edges → backlinks +
graph. Updates incrementally on file watch.

**Rationale:** "Node relations, concept, data" (user) needs more than backlinks.
Frontmatter-declared relations + tags give typed edges (concept/data/relation),
not just link adjacency. Wiki-link → file resolution is the missing piece today
(links are parsed but unresolved — confirmed in exploration).

**Renderer:** Reuse the existing `@xyflow/react` + `@dagrejs/dagre` pattern from
`src/lib/ghaWorkflow/render/` (`toGraph` → `layout` → render). The served page
uses a JS bundle; the in-app panel reuses the React components.

### ADR-6 — Server binds loopback only, session-cookie auth, one-per-workspace, tied to window lifecycle

**Decision:** Bind `127.0.0.1:0` (OS-assigned port). Write port + random
bootstrap token to a file in app-data (reuse the MCP bridge `write_port_file`
pattern). **Auth transport is session-cookie based, not per-request header**
(see ADR-9 — a header-only scheme is impossible for browsers, static assets,
SSE, and Slidev HMR). Start the server when a workspace gains focus; stop on
workspace close / app exit.

**Rationale:** Matches VMark's localhost posture (MCP bridge). Workspace
**trust** gating (`workspaceStore.isWorkspaceTrusted`) must pass before serving
— an untrusted workspace's content is never served.

### ADR-9 — Auth/origin model: one proxied origin, bootstrap-token → HttpOnly session cookie

**Problem (review D1.2):** A "token on every request" rule cannot work for an
external browser, `<img>`/static assets, `EventSource` (SSE), or Slidev's Vite
HMR WebSocket — none can attach custom headers.

**Decision:**
- **Single origin.** The Hono server is the *only* exposed origin. Slidev runs
  on an internal sub-port and is **reverse-proxied** under the KB origin
  (path-prefixed, incl. the HMR WebSocket upgrade). If S0.2 shows Vite
  middleware/proxy of HMR is unreliable, fall back to exposing Slidev on its own
  loopback port with the **same cookie** check.
- **Bootstrap → cookie.** VMark opens `/__auth?t=<bootstrapToken>` (token from
  the port-file); the server validates it once and sets an **HttpOnly,
  SameSite=Strict, loopback-scoped** session cookie. All subsequent requests
  (HTML, assets, APIs, SSE, HMR) authenticate via the cookie. The bootstrap
  token is single-use / short-TTL so it doesn't linger in browser history.
- **CSRF.** State-changing routes (export trigger, etc.) require a
  double-submit token or are POST-only with `SameSite=Strict`; GET routes are
  side-effect-free.

**Consequence:** "Open in browser" performs the bootstrap redirect so the user's
browser gets the cookie. Defined per route class in Phase 1/4 DoD.

### ADR-10 — KB and Slidev are supervised child processes, not one fragile process

**Problem (review D5.4):** One Node process hosting both KB and Slidev is a
single point of failure — a Vite/Slidev crash or memory leak would take down KB.

**Decision:** One *provisioned runtime*, but a thin **supervisor** owns two
child processes: the always-on KB server and an on-demand Slidev server. The
supervisor restarts a crashed child independently, caps Slidev memory, and
reports health to Rust. KB availability never depends on Slidev liveness
(reinforces ADR-1's fallback).

### ADR-7 — In-app surfaces are AppShell slot registrations

**Decision:** The KB inspector panel and Slidev preview panel register as slots
in `src/shell/AppShell.tsx` (ADR-007 compliance) — no edits to `App.tsx`. The
KB graph reuses `@xyflow/react`.

### ADR-8 — Security containment

**Decision:** (a) All file reads are contained to the workspace root —
path-traversal rejected (reuse `content_search.rs` symlink-skip + root-prefix
checks; mirror for the Node server). (b) Rendered HTML is sanitized (DOMPurify
on a Node DOM — see ADR-4). (c) Remote-resource policy per §3bis (CSP + trust),
not a blanket ban. (d) Bundles are signed-manifest-verified before execution
(ADR-2). (e) Auth per ADR-9.

**Security is designed up front, not deferred:** the threat model + CSP/header
table are produced in **S0.6** and implemented in **Phase 1**. Phase 8's
security-review skill pass is the **final audit**, not the first time security
is considered (review D2.4/D5.3).
