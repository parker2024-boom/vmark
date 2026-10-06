# Decisions — Two Documents Side-by-Side in One Window (#1081)

> Plan: `dev-docs/plans/20260701-split-documents.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: split documents (`src/stores/paneStore.ts`, `src/contexts/PaneContext.tsx`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-1 — A per-window pane registry; keep `activeTabId` as the focused
  pane's alias.** Introduce a pane model (max **2** panes for v1: `primary`,
  `secondary`). Store in a new `paneStore` (or a `panes` slice on `tabStore`)
  keyed by window: `{ layout: "single" | "split", orientation: "horizontal" |
  "vertical", fraction, panes: PaneEntry[], focusedPaneId }`, where
  `PaneEntry = { id, activeTabId }`. **Crucially**, keep
  `tabStore.activeTabId[windowLabel]` working as a *derived alias of the focused
  pane's `activeTabId`*, so the ~dozen existing `useActiveTabId()` consumers keep
  functioning unchanged until they are parametrized (ADR-2). No big-bang.

- **ADR-2 — Parametrize document access via `PaneContext`, not prop-threading.**
  Add a React `PaneContext` that provides the current pane's `tabId`. Make
  `useDocument*` read the pane's tab when rendered inside a pane, falling back to
  `useActiveTabId()` (focused pane) when no context. This avoids threading a
  `tabId` prop through every call site — the same pattern `WindowContext` already
  uses for `windowLabel`. `Editor.tsx` takes an optional `tabId` prop and mounts
  `useUnifiedMenuCommands` **once per window** (lift it out of the per-pane path).

- **ADR-3 — De-singleton the active editor by pane; expose "focused pane's
  editor."** `editorStore` tracks registered editors per `paneId`; the toolbar /
  find bar consume a `selectFocusedPaneEditor` read-model. `TiptapEditor` /
  `SourceEditor` register under their pane id.

- **ADR-4 — v1 view-mode flags stay window-global; per-pane view modes are a
  follow-up.** `sourceMode` / `focusMode` / find apply to the **focused pane**
  for v1 (the window-level CSS classes in `App.tsx` move to per-pane class
  application). True independent per-pane view modes (one side Source, other
  WYSIWYG) is desirable but deferred to keep v1 tractable — documented as a known
  limitation. (cursor/content/dirty/selection are already per-tab, so they need
  no duplication — only ADR-2's pane-scoped reads.)

- **ADR-5 — One draggable divider component, combining existing pieces.** New
  `DocumentSplitContainer` renders two `<Editor>`s + a divider that merges
  `split-pane-editor.css` layout + the keyboard a11y from `SplitPaneEditor`'s
  `role="separator"` handler + mouse-drag from `useSidebarResize`.

- **ADR-6 — Sync scroll is opt-in and ratio-based, behind the
  `isInternalChange` echo guard.** Map `scrollTop / scrollHeight` across panes;
  guard against feedback. Off by default; a per-split toggle.

- **ADR-7 — Persist split layout as per-machine UI state in `localStorage`.**
  Original plan: an additive `splitLayout` field in `WorkspaceConfig` (TS + Rust
  round-trip). **Revised during Phase 4:** the split layout is per-machine UI
  state (like window size), not shared project config — persisting it in the
  `.vmark` config would leak one machine's pane layout to collaborators and grow
  baselined Rust/store files past the file-size gate. Instead it lives in
  `localStorage` keyed by workspace root (`vmark-split-layout:<rootPath>`),
  storing `{ orientation, fraction, syncScroll, primaryPath, secondaryPath }`.
  Both pane paths are persisted so restore is deterministic — inferring the
  primary from "whichever tab is active after restore" could collide with the
  secondary and drop the real primary from view. Absent key ⇒ single-pane
  (back-compat). Written by `workspaceSession.ts`; restored by
  `restoreSplitLayout` after tabs load, best-effort (skipped if either file is
  gone or both paths resolve to the same tab).
