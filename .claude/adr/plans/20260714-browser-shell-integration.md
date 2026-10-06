# Decisions — Browser ↔ VMark Shell Integration

> Plan: `dev-docs/plans/20260714-browser-shell-integration.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: browser tabs in the shell (`src/components/Browser/`, `src/services/browser/`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7, ADR-8. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1 — Occlusion: `setHidden` is full-cover only; partial overlaps need a snapshot

- **"Full-cover" means OPAQUE coverage of the entire browser intersection** — not
  merely DOM coverage. (Codex v3, D1#3/D4#5: the workflow `ApprovalDialog`,
  `QuickLookOverlay` and `DropOverlay` have **translucent** backdrops or margins, so
  hiding the webview behind them exposes a blank rectangle and breaks the intended
  composition. They are **snapshot-freeze**, not hide-only.) Only an overlay that
  paints opaque pixels over every pixel of the intersection may use hide-only.
- **Full-cover** overlays (crash, JS dialog — both opaque, full-rect) may use the
  existing `setHidden` freeze.
- **Partial** overlaps MUST either (a) be moved out of the rect, (b) be **disabled**
  while a browser tab is visible, or (c) freeze with a **page snapshot**
  (`WKWebView.takeSnapshotWithConfiguration:` → image → DOM overlay) so the
  un-covered page area still shows.
- Snapshot-freeze **does not exist**. Phase OC either builds it or mechanically
  enforces (a)/(b) for every row of the inventory above.
- Every UI change states its occlusion behaviour explicitly. "Looks fine on my
  monitor" is not evidence.

### ADR-2 — The sidebar follows the active tab's kind (decided)

Browser tab active → browser views (history, bookmarks); document tab → file views
(explorer, outline, file history). An extension of `uiStore.sidebarViewMode`, not a
new mechanism. In split view, "active tab" means **the focused pane's tab**
(`paneStore`) — this is part of acceptance, not an implementation detail.

Rejected: two persistent manual sidebar tabs (VS Code activity-bar style) — more
state for the user to manage, and it decouples the sidebar from the tab it reflects.

### ADR-3 — MCP is the ONLY driving channel; the CLI is dropped (not deferred)

The driver has exactly one audited automation channel: the MCP bridge (`read`/`act` →
approval gate → `browser_eval`, with the origin guard, one-shot expiry, R7a). A
`vmark browser` CLI — even a "thin client" — re-introduces a navigate path that R7a
assumes does not exist (R7a trusts that only the human/frontend controls which page
loads). A human already has the omnibox; the AI already has MCP. **Dropped.** If a
real need appears it re-enters as its own security-reviewed plan.

### ADR-4 — Browser nav chrome lives in the bottom `StatusBar` (omnibox) — IMPLEMENTED

Back / forward / reload / stop and the address bar (an **omnibox**: a URL *or* a
search query) render in the bottom bar — the same bar that hosts the tab strip —
only while the active tab is a browser. The old top `.browser-chrome` strip is gone;
`BrowserSurface` is viewport + full-cover overlays only.

- **Occlusion:** the bar sits *below* the browser rect → never overlaps → safe with no
  freeze. An omnibox **autocomplete dropdown** *would* open upward over the rect and is
  therefore **out of scope until Phase OC**.
- **Bottom-lane precedence (re-review D1#4, fixed):** the bar is a 40px mux shared with
  the editor `UniversalToolbar` and the `FindBar`, and `StatusBar` can be hidden (F7).
  Since the omnibox is the browser's *only* chrome, a browser tab **owns the lane**:
  the StatusBar renders even when hidden, and the formatting toolbar + find bar are
  suppressed (neither applies to a native page — VMark's find searches the editor
  document, which a browser tab has none of).

### ADR-5 — Browser nav UI state is lifted into a small shared store — IMPLEMENTED

A transient `browserUiStore` (keyed by `tabId`) holds `{ urlInput, loading, canGoBack,
canGoForward }`; `BrowserSurface` writes it from the nav-delegate events, the bottom-bar
`BrowserOmnibox` reads it. `crash`/`dialog` stay local to `BrowserSurface` (full-cover
overlays it owns). Navigation is a stateless service (`browserNavigation`). Not persisted.

- **Lifecycle (re-review D1#2, corrected):** the entry is seeded on `BrowserSurface`
  **mount** and cleared on **unmount** — *not* on tab close. This is deliberate and
  consistent: `Editor.tsx` mounts the surface only for the active tab, so a tab switch
  already unmounts it and `browser_destroy`s the native webview. The tab reloads on
  return, so its UI state is correctly reseeded. (If browser tabs ever become
  *persistent across switches*, this cleanup must move to a tab-close subscriber.)

### ADR-6 — ALL browser events are window-routed (moved to Phase 0)

`nav_delegate_macos.rs` emits via `app.emit` — a **broadcast to every window** — and no
payload carries a window label. With two document windows each showing a browser tab,
both windows' omniboxes and history views react to the other's navigation. v2 deferred
this to Phase 2; the re-review is right that Phase 1 already makes these events
authoritative for shared chrome, so **routing moves to Phase 0, before more consumers
are added**. The contract applies to **every** browser event (navigated, loaded,
failed, crashed, popup, dialog), not just `NavPayload`: prefer targeted Rust-side
emission to the owning `WebviewWindow`, with payload-label filtering as defence in depth.

### ADR-7 — Bounds are position-aware, not just size-aware (NEW)

`BrowserSurface` reports bounds from a `ResizeObserver`, which fires on **size**
changes. Moving a same-sized panel (terminal left↔right, sidebar open/close that
shifts rather than resizes) changes the rect's `x/y` **without** firing it, leaving the
native view mis-aligned over unrelated UI. Bounds must also be re-reported on
layout-state changes (panel visibility/position, split-pane changes, window move), and
the DOM→AppKit coordinate conversion must be a documented invariant, verified as
`browserRect ∩ statusBarRect = ∅` at every panel position and backing-scale factor.

### ADR-8 — Native focus is part of the contract (NEW)

Once the `WKWebView` is first responder, **React's `window.keydown` never sees the
keystroke** — verified live: `Cmd+W` did not close the browser tab, and the Phase 0
`Alt+Mod+Shift+B` trigger will not fire while the page has focus. Any command that must
work "while browsing" therefore needs a **native/menu route**, not a DOM listener.
Focus return after navigation/dialogs, and IME preservation, are part of this contract.
