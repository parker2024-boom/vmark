# Decisions — Browser Automation — Richer Perception & Interaction

> Plan: `dev-docs/plans/20260715-browser-automation-perception.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: AI browser automation (`src/lib/browser/agent/`, `src-tauri/src/browser/`).
> Defines: ADR-A1, ADR-A2, ADR-A3, ADR-A4, ADR-A5, ADR-A6, ADR-A7. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-A1 — Screenshot is a native command, not an eval

`read`/`act` inject JS into the isolated content world via `browser_eval`. A
screenshot cannot be produced that way (an isolated world cannot rasterize the
page). It is a new native command `browser_screenshot(tabId, generation)` calling
`WKWebView.takeSnapshotWithConfiguration:completionHandler:`. **SPIKE-5 already
proved this on a VMark-owned embedded webview** (14 ms, full-size image;
`dev-docs/grills/embedded-browser/SPIKE-5.md`). The command applies the same
freshness/origin/policy checks as `browser_eval` before capturing, returns a
base64 JPEG (quality-bounded to cap payload size), and never reads DOM. The
occlusion controller (`browser_freeze`/`browser_thaw`) is unaffected — screenshot
captures the live view, not a frozen snapshot.

### ADR-A2 — Element refs live in the isolated world, invalidated per generation

`ariaSnapshot` (`aria.ts`) gains a monotonic ref per emitted node, backed by a
`WeakMap<Element, string>` **held in the isolated content world** so refs survive
repeated `read`s within one committed page. On navigation the world is torn down
(new document), so refs cannot leak across pages — and `act`-by-ref still passes
`generation`, so a ref from an old page is rejected by the Rust freshness gate
regardless. `queryByRef(ref)` resolves the handle back to the element for
`actScript.ts`. Refs are advisory-locating only; **authorization is still by
committed origin + operation**, never by ref.

### ADR-A3 — `wait_for` polls inside the isolated world, bounded by the budget

A `wait_for(condition, timeoutMs)` handler runs a bounded `MutationObserver` (with
an interval fallback) in the isolated world and resolves on first match or
timeout. It is read-class (observing the DOM), returns the matched ref(s), and
never mutates. The wait is capped by `validateTimeout`; the Rust side treats it
as a `read` operation for authorization.

### ADR-A4 — `scroll`/`key` are act-class, and honestly synthetic

`scroll` (via `scrollIntoView`/element scroll) and `key` (via dispatched
`KeyboardEvent`) mutate observable state, so they are act-class: approval-gated,
generation-stamped, one-shot-target-bindable, exactly like `click`/`type`. Per
SPIKE-3 the events are synthetic (not `isTrusted`); the tool description states
this limitation so the model does not conclude a site "ignored" a keypress it
never trusted. `key` never sends OS-level shortcuts — only page-directed
`KeyboardEvent`s to a focused ref.

### ADR-A5 — Operation vocabulary extends in exactly two places

New operations are added to `BROWSER_OPERATIONS`
(`src/lib/browser/approval/grants.ts`) and the Rust `Operation` enum
(`src-tauri/src/browser/operation.rs`) — the two single-definition sets the whole
gate reads. The additions fall into three authorization classes:

| Class | Operations | Consent |
|---|---|---|
| **read** (non-mutating perception) | `screenshot`, `wait`, `query` — authorize under the existing `read` grant | a "read" grant already covers non-mutating perception; no new grantable op |
| **act** (mutation) | `scroll`, `key`, `style` — new grantable ops, default-deny, approval-gated, generation-stamped | like `click`/`type` |
| **eval** (escape hatch) | `execute_js` — new op, **per-call approval only, never a standing grant** | highest friction; see ADR-A6 |
| **session** (identity) | `session.save` / `session.load` / `session.clear` — user-gated, not AI-grantable | handles credentials; see ADR-A7 |

A test asserts the frontend and Rust vocabularies never drift, and that `eval` and
the `session` ops are excluded from the grantable (remember-able) set.

### ADR-A6 — Scripted eval is isolated-world, per-call-approved, untrusted-result

`execute_js` is the capability VMark otherwise avoids, so it is fenced on four
sides rather than one:

1. **Isolated content world only.** Caller scripts run in the driver's
   `WKContentWorld`, which shares the DOM but not the page's JS heap/globals. That
   is exactly what makes DOM detection and CSS manipulation safe-ish — they are
   DOM operations — while denying access to the page's own functions and any
   secret held only in page JS. Main-world / `pageWorld` eval is **out of scope**;
   adding it is a separate decision.
2. **Per-call approval, never a standing grant.** `eval` is absent from the set an
   origin can be *remembered* for. Every `execute_js` raises a fresh approval that
   shows the script; "remember for this site" is not offered. `query` (read) and
   `style` (act) remain grantable; raw `eval` is not.
3. **Generation-stamped + committed-origin gated**, identical to `read`/`act`.
   `browser_eval` already reads the committed origin from its own registry and
   rejects a stale generation; caller scripts get no weaker path. The command
   gains a caller-script arm guarded by the `eval` op, not a new command.
4. **Result is untrusted.** The return value is handed to the AI labeled
   page-derived/untrusted and is never auto-fed into a subsequent `act` target;
   the full script is logged (URL redacted) for audit. This *bounds* — it does not
   eliminate — the exfiltration risk that is inherent to giving an LLM eval on an
   untrusted page, and which the product owner has explicitly accepted.

### ADR-A7 — Sessions are named contexts; the AI holds a reference, never the tokens

Login reuse today is coarse: `aiSession: "shared"` puts the AI inside the human's
entire live persistent session; `"sandbox"` is wiped every app-lifetime. This ADR
adds a middle tier borrowed from Playwright's *browser contexts + `storageState`*,
under four rules:

1. **Named, persistent, isolated contexts.** Each profile is its own
   `WKWebsiteDataStore` keyed by a stable UUID via
   `dataStoreForIdentifier:` (macOS 14+; SPIKE-4 already probed identifier stores
   with no crash). Extends `browser_store_macos.rs`, which today holds one
   non-persistent sandbox store, into a keyed map of named stores. Contexts do not
   share cookies/storage with each other, with the sandbox store, or with the
   human's default store.
2. **Credential-by-reference.** Cookies are session tokens. The AI names a context
   (`"github-work"`) or a saved-state handle; it **never receives raw cookie or
   token values**. Export/import moves through Rust (`WKHTTPCookieStore` for
   cookies; per-origin isolated-world eval for `localStorage`, best-effort). The
   secret stays server-side.
3. **Secrets are protected at rest and never logged.** A named context lives in
   the OS-protected WebKit container. An *exported* `storageState` blob is
   sensitive-at-rest: it is encrypted (OS keychain-wrapped key) or written only to
   a user-chosen secure location — never plaintext in a workflow file, never in
   logs, always redacted at the trust boundary.
4. **Loading an identity is a user decision.** `load_storage_state` / opening a tab
   against a named context grants the AI an authenticated identity, so it requires
   explicit user approval (its own `session` operation class — user-gated, not an
   AI-grantable standing operation). Clearing data is likewise user-initiated.
