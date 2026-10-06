# Decisions — Two Documents Side by Side (#1081)

> Plan: `dev-docs/plans/20260629-1010-side-by-side-documents.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: two documents side by side (first design; superseded by the split-documents plan).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5b, ADR-6b, ADR-8, ADR-5, ADR-6, ADR-7. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-1 — Pane-aware window model.** Per window: `panes: { primary: tabId,
  secondary: tabId | null }` + `focusedPane: "primary" | "secondary"`. Single-pane
  today = `secondary: null`. Lives in `tabStore` (already window-keyed).

- **ADR-2 — `getFocusedTabId(windowLabel)` is a NEW read API; `activeTabId`
  stays as-is.** (Revised per Codex finding 1.) `activeTabId` remains the
  tab-strip's writable lifecycle state (selection, close-fallback, detach,
  reopen, hot-exit) — it is **not** redefined as a derived alias. New code that
  needs "the document the user is acting on" calls `getFocusedTabId`, which in
  single-pane mode returns `activeTabId[windowLabel]` and in two-pane mode returns
  the focused pane's tab. Consumers migrate explicitly, one call site at a time.
  Clicking a pane/editor (not UI chrome — see ADR-8) sets `focusedPane`.

- **ADR-3 — MCP: omitted `tabId` → focused pane; explicit `tabId` PRESERVED.**
  (Revised per Codex finding 3.) The bridge already lets `document.read/write/
  transform` target any tab by explicit `tabId`, including non-active — that
  stays. Only the *implicit* resolution (no `tabId`) changes from "active tab" to
  "focused pane" via `getFocusedTabId`. View-state tools (`selection.*`) resolve
  the focused pane's live editor. No protocol/sidecar change; an explicit
  `{ pane }` arg remains a deferred, additive v2.

- **ADR-4 — `editorStore` becomes a keyed registry; React via PaneContext,
  non-React via an imperative resolver.** (Revised per Codex findings 2 & 3.)
  The singleton slices (`active*`, `tiptap.editor`, source context, toolbar
  context, debug view) are insufficient for two panes. Replace with
  `editorsByPane` (or `editorsByTab`) registries + `getFocusedEditor(windowLabel)`.
  React descendants read a `PaneContext`; imperative call sites (MCP handlers,
  command services, toolbar adapter utils, the window-level menu dispatcher) use a
  parallel `resolveFocusedEditor()` service — **PaneContext alone cannot reach the
  ~15 non-React call sites.**

- **ADR-5b — One window-wide editor mode for v1.** (New, per Codex finding D2-4.)
  `sourceMode`/`markdownSplitView` stay window-global for v1; both panes share the
  mode. Per-pane mode (e.g. WYSIWYG left, source right) is an explicit non-goal
  for v1, documented as a known limitation. Revisit only if the reference-pane UX
  demands it.

- **ADR-6b — `EditorSurface({ tabId, paneId })`, one window-level menu
  dispatcher.** (Revised per Codex finding 4.) Do NOT mount two `<Editor>`
  instances (each would re-resolve the active tab and duplicate menu listeners).
  Extract a parameterized `EditorSurface` that takes its `tabId`/`paneId`
  explicitly; the menu dispatcher stays single and window-level, routing to the
  focused pane. This requires tab-scoping `useDocumentState` + the Tiptap/Source
  surfaces FIRST (see Phase 1).

- **ADR-8 — Focus retention rules.** (New, per Codex finding D4-4.) Focusing UI
  chrome (FindBar, toolbar, status bar, terminal, modals) must NOT change
  `focusedPane`. Pane focus changes only when a pane's editor gains focus or the
  focused pane closes.

- **ADR-5 — Reuse the existing split layout.** New `DualDocumentPane` hosts two
  `<Editor>` instances, each wrapped in a `PaneContext`, using the existing
  `split-pane-editor.css` divider/resize. No new layout primitive.

- **ADR-6 — Sidebar / Status / Find are focus-aware.** Outline, FindBar, StatusBar
  bind to `focusedPane` (follow focus), not split into two — keeps the chrome
  simple; the focused pane drives them.

- **ADR-7 — Scroll-sync is a separate, opt-in phase.** Proportional
  (ratio-based) scroll sync for bilingual reading is genuinely useful but
  independent; it ships after the core split works.
