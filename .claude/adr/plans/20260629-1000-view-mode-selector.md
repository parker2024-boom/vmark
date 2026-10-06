# Decisions — View Menu Mode Selector + Toggle Correctness (#1070)

> Plan: `dev-docs/plans/20260629-1000-view-mode-selector.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the View-menu editor-mode selector.
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-1 — A derived `editorMode` read-model, NOT a storage refactor.** The two
  booleans are *already* mutually exclusive at their only mutators
  (`uiStore.ts:319-322` — each toggle clears the other), so illegal "both true"
  states are not actually reachable. Replacing them with a single stored
  `editorMode` field would touch 26 non-test consumers for marginal benefit — a
  drive-by refactor the project rules warn against. Instead add a **pure derived
  selector** `selectEditorMode(s) → "wysiwyg" | "source" | "split"` (mirrors the
  existing `selectSourceEditing` pattern) as the canonical read-model the menu-sync
  hook consumes. The booleans stay as the stored mutators; no consumer churn.

- **ADR-2 — Native macOS radio group, not a relabel or a submenu.** Model the
  three modes as three `CheckMenuItem`s in the View menu — `wysiwyg-mode` (new),
  `source-mode`, `markdown-split` — with the active one checked. This is the
  Finder *View → as Icons / List / Columns* idiom: it makes the active mode and
  the mutual exclusivity obvious natively (resolves issues 1 and 3 at once)
  without dynamic relabeling (issue's "WYSIWYG Mode" suggestion) or a nested
  submenu (worse discoverability, extra click). A new top-of-View "Editor Mode"
  separator groups them visually.

- **ADR-3 — Reverse menu-state sync mirrors `accelerators.rs`.** The menu needs
  to follow store state (mode change → checkmark moves). Add `menu/menu_state.rs`
  modeled exactly on the proven `accelerators.rs` differential pattern: a
  `sync_view_menu_state` command walks the live menu tree, sets `checked` /
  `enabled` per item, backed by a `MENU_STATE_CACHE` diff so each change is ~1
  main-thread hop, not a full rebuild. `collect_kind` in `accelerators.rs` is
  extended to also index `MenuItemKind::Check` (today it ignores Check items —
  otherwise the new CheckMenuItems' accelerators would stop updating, a
  regression on `F6` / `Shift+F6` / `Alt+Z` / `Alt+Cmd+L`).

- **ADR-4 — Word Wrap & Line Numbers are *disabled* (greyed), not hidden, when
  they don't apply.** Enabled iff `editorMode !== "wysiwyg"`. Disabling (vs
  hiding) keeps the menu stable and signals "not applicable here" — the standard
  macOS idiom; hidden items make menus jump. Plus the Split-View functional fix:
  wrap `EditorView.lineWrapping` in a Compartment driven by `wordWrap`, parallel
  to `useSourceEditorSync`.

- **ADR-5 — "Code-block line numbers in WYSIWYG" is decoupled, not regressed.**
  Disabling the gutter "Line Numbers" item in WYSIWYG would remove today's
  code-block line-number toggle there. That conflation is exactly what issue 2
  flags. **Decision needed (see Open Questions):** move code-block line numbers to
  a code-block-local affordance / markdown setting (follow-up), or keep a
  WYSIWYG-only path. Default in this plan: treat the View-menu item as
  *source-gutter* line numbers only; track code-block gutters as a separate
  follow-up so we don't silently drop the feature.

- **ADR-6 — Modes apply to markdown documents only.** For non-markdown tabs
  (yaml-workflow, viewers) the three mode items and Word Wrap / Line Numbers are
  disabled. The sync hook reads the focused tab's `kind` (format config) and
  gates accordingly.
