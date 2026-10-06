# Decisions — Embedded Browser, Site Plugin System & Web Workflows

> Plan: `dev-docs/plans/20260712-0610-embedded-browser-sites-workflows.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the embedded browser, site registry and browser workflows (`src-tauri/src/browser/`, `src/lib/sites/`, `src/lib/browser/workflow/`).
> Defines: ADR-B1, ADR-B2, ADR-B3, ADR-B4, ADR-B6, ADR-B5, ADR-S1, ADR-S2, ADR-S3, ADR-S4, ADR-W1, ADR-W2, ADR-W3. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

**ADR-B1 — System webview, not bundled Chromium (CEF).**
- Options: (a) embed CEF/Chromium; (b) drive user's external Chrome via CDP; (c)
  system webview per platform.
- Decision: **(c)**.
- Rationale: (b) can't be displayed inside the VMark window (macOS can't reparent
  another process's window) — the user explicitly requires in-app display. (a) makes
  VMark a browser vendor (weekly Chromium CVEs to patch in an app holding login
  sessions), adds 150–300 MB/platform, fights Tauri's process/window model, and buys
  nothing here (CDP already available on Windows via WebView2; extensions run in no
  embedded engine). System webviews are OS-patched.
- Rejected: (a) security+size+integration cost with no offsetting benefit; (b)
  fails the display requirement.

**ADR-B2 (REVISED post-Codex) — VMark creates and owns a raw native webview; it is
NOT a Tauri webview and does NOT use `add_child`.**
- Options: (a) Tauri `window.add_child()` multi-webview (`unstable`); (b) separate
  Tauri `WebviewWindow` companion; (c) **VMark constructs the platform webview itself
  (`WKWebView` / `CoreWebView2` / `WebKitWebView`) and adds it as a native child view of
  the Tauri window's content view**, obtained through `with_webview`; (d) screenshot
  streaming into a canvas.
- Decision: **(c)**.
- Rationale (this is the plan's most important change):
  1. **Security, decisively.** Tauri prepends `__TAURI_INTERNALS__`, the invoke bridge,
     and plugin init scripts to *every* webview it creates — `add_child` included
     (`tauri-2.11.5/src/manager/webview.rs:166-224`, verified). A capability file
     restricts authorization, **not injection**. Under (a) or (b), every hostile page
     gets a live IPC object to probe. Under (c) no bridge is ever injected — R3 becomes
     structural instead of configured.
  2. **Capability.** Owning `WKWebViewConfiguration` unlocks exactly what the feature
     needs and (a)/(b) cannot give: `WKContentWorld` (isolated agent world, I2),
     `callAsyncJavaScript` (**await `fetch()`** — `evaluateJavaScript` cannot await a
     Promise, so publishing is impossible without it), `WKWebsiteDataStore` (profiles),
     and the `WKUIDelegate`/`WKNavigationDelegate`/`WKDownloadDelegate` hooks required
     for dialogs, popups, downloads, and TLS errors (R12).
  3. **Cost is near zero.** `objc2`, `objc2-app-kit` (`NSView`/`NSWindow`), and
     `objc2-web-kit` (`WKWebView`, `WKWebViewConfiguration`, `WKNavigationDelegate`,
     `block2`) are **already direct dependencies** (`src-tauri/Cargo.toml:65-70`).
  4. **Drops the `unstable` feature and its bug class entirely** (rendering #11376,
     positioning #10420, user-agent #9492 no longer apply).
- Cost accepted: VMark now owns webview lifecycle, bounds, focus, and z-order on three
  platforms — real work, and the reason Windows/Linux embedding is spiked in Phase 0
  (WI-0.6) rather than deferred.
- Rejected: (a)/(b) break the core security invariant and cannot provide isolated
  worlds or async eval; (d) high latency, not a real browser.

**ADR-B3 (REVISED) — One-directional driver; isolated agent world; async eval.**
- Decision: drive the owned webview via native eval; run the agent in an isolated
  content world (I2); use **`callAsyncJavaScript`** (macOS 11+) wherever a result
  depends on a Promise (`fetch`, waits) and `evaluateJavaScript` only for synchronous
  reads. Results flow Rust ← page as return values; the page never initiates a message.
- Rationale: `evaluateJavaScript` returning a `Promise` yields an opaque object, not the
  resolved value — the v1 plan's publishing and wait primitives would have silently
  failed on it. (Codex D3-3.)
- Consequence: **macOS 11 is the effective floor for publishing/workflows.** On 10.15
  the browser is read-only (see Q7).

**ADR-B4 — Profile isolation via `data_store_identifier`, degrade below macOS 14.**
- Decision: use `data_store_identifier` for a VMark-owned browser profile; on
  macOS <14 (or if the documented crash #12843 reproduces) fall back to the default
  persistent store (still persists cookies; just not isolated from other webviews).
- Rationale: isolation is desirable, not load-bearing; persistence is load-bearing.

**ADR-B6 — No supervised daemon; state splits app-support vs workspace by *authority*,
not by convenience.**
- Context: v1 of this design (Playwright-MCP sidecar) implied a supervised child process
  with a port file, like `content_server`. **The revised design has no daemon at all** —
  the webview is created in-process by the Tauri core (ADR-B2). No child process, no
  supervision, no port file, no `login_shell_path`. `content_server/spawn.rs` remains a
  *pattern* reference only; the browser does not reuse it.
- Decision: the state that *does* need a home splits on one rule — **user-authored intent
  lives in the workspace; machine identity, session state, and anything conferring
  authority lives in app-support.**

| State | Location | Rationale |
|---|---|---|
| `data_store_identifier` (profile UUID) | `app_data/browser/profile` | Sessions are per-user-per-app. Per-workspace would force re-login per folder. (The cookie jar itself is **not ours** — WebKit owns `~/Library/WebKit/<bundle-id>/WebsiteDataStore/<uuid>`; we persist only the UUID.) |
| Approval standing grants (R5) | `app_data/browser/grants.json` | **Security-critical.** A grant confers publish authority. In the workspace, a `git clone` / Dropbox sync would carry a standing publish grant to another machine or person |
| Run records / logs (R9) | `app_data/browser/runs/<workspace-hash>/` | Per-workspace **scope**, app-support **storage** — the `content_server` pattern (keyed by root, stored centrally). They contain page content and URLs; they must not be committable by accident |
| Hibernation snapshots (R6) | `app_cache/browser/snapshots/` | Regenerable and large; the OS may reclaim them. **Deliberately diverges** from `workflow-snapshots/` (which sits in `app_data`) — snapshots are a cache, and treating them as one is correct even though the local precedent differs |
| Site enablement, ad-hoc origins | settings store (app-support) | Configuration, not content |
| **Workflow `.md` files** | **workspace root** | The *only* thing that belongs there. They are user-authored documents — edited in VMark, diffed in git, shared. This is the point of ADR-W1 |

- **Rule (normative):** nothing that grants authority or holds session identity may live
  in a directory a user might copy, sync, or commit. If a future feature wants to put a
  grant or a session in the workspace, that is a red flag, not a convenience.
- **Privacy consequence:** run logs and snapshots contain page content, so the "clear
  browsing data" UX (R12/WI-1.5) must clear **all three** of the WebKit data store, the
  run records, and the snapshot cache — not just cookies.
- **Rejected: per-workspace browser profiles.** Tempting (work identity vs personal
  identity per project), but implicit binding of identity to folder produces the worst
  class of surprise ("why am I logged out in this folder?") and silently multiplies live
  session stores. If multi-profile ships in v2, a profile is a **user-selected identity**,
  never an implicit function of the workspace. (Q10.)

**ADR-B5 — Two interaction tiers: synthetic DOM, then native input.**
- Decision: default to synthetic events (`isTrusted:false`, works on most sites);
  escalate to native input where needed. **Native trusted input is a Windows/CDP
  capability, NOT a macOS one** (revised per SPIKE-3).
- Rationale: native input is the reliable path but platform-specific and heavier;
  synthetic covers the common case cheaply.
- **SPIKE-3 finding (2026-07-12):** synthesizing an `NSEvent` mouse click (both
  `sendEvent` and queue-`postEvent`, app activated + webview first responder) delivered
  **no** click to the embedded WKWebView's DOM (`received:false`) — not even an untrusted
  one. WebKit accepts input through the real window-server/HID path, not app-level
  `NSEvent` posting. So on macOS the interaction tier is **synthetic DOM events only**;
  genuinely-trusted input is Windows-via-CDP. (CGEvent HID injection is out of scope —
  needs Accessibility permission and still wouldn't guarantee `isTrusted`.) This is
  design-consistent — the plan's platform table already flagged macOS trusted input as
  unproven; it is now confirmed unavailable-via-NSEvent.

**ADR-S1 — Site registry dispatches on origin, mirrors format registry.**
- Decision: `src/lib/sites/registry.ts` with `registerSite(manifest+orchestrator)`,
  `dispatchSite(url)`, settings-gated `bootstrapSites()`. Rationale: proven pattern,
  keeps per-site mess out of the AI tool layer (as `dispatchEditor` keeps format mess
  out of `Editor.tsx`).

**ADR-S2 — In-page module ≠ host orchestrator.**
- Decision: split each plugin into (1) an injected in-page JS bundle (DOM +
  same-origin fetch, namespaced global, no Tauri) and (2) a host-side typed
  orchestrator (sequences via the driver). Rationale: only the in-page half can do
  same-origin fetch/DOM; keeping it minimal and Tauri-free preserves R3.

**ADR-S3 — Built-in plugins compiled in-repo; third-party sandboxed, no marketplace.**
- Decision: built-ins live in `src/lib/sites/adapters/` (reviewed, i18n'd, tested).
  Third-party plugins (post-v1) run their host layer in a Web Worker behind a
  message-channel facade. No remote auto-updating registry in v1.
- Rationale: avoids opening a supply-chain door; matches governance §4 stance.

**ADR-S4 — Publishing = same-origin fetch (Wechatsync mechanism), reimplemented.**
- Decision: publish by executing `fetch()` in the page context against the platform's
  own web APIs with the user's cookies. Reimplement the mechanism; do **not** copy
  Wechatsync's GPL-3.0 code into VMark (integrate by mechanism, not by linking).
- Rationale: indistinguishable from the user's own editor; DOM puppeteering is the
  fragile fallback only.

**ADR-W1 — Workflow file is markdown with typed steps.**
- Decision: workflows are `.md` files (front-matter + step list) in the workspace,
  editable in VMark, git-diffable. Rationale: VMark is a markdown editor; reuse the
  editor, versioning, and sharing for free.

**ADR-W2 — Four execution tiers with escalation + self-healing.**
- Decision: `api` (recorded same-origin fetch replay) → `action` (semantic locator)
  → `goal` (AI loop) → vision (screenshot+coords+native input). Broken deterministic
  steps escalate to `goal`, complete the run, and propose a patch. Rationale: "no
  DOM" is not a wall — it's tier selection; recording lifts DOM actions to API tier.

**ADR-W3 — Recorder captures dual trace (actions + network).**
- Decision: the recorder logs semantic actions AND the network requests they fire
  (injected fetch/XHR interception on WebKit; CDP Network domain on WebView2), then
  generates a workflow file preferring the API representation. Rationale: replaying
  requests is more stable than replaying clicks.
