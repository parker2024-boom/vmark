# Decisions — Split-Pane View Modes — Source / Split / Preview

> Plan: `dev-docs/plans/20260703-split-pane-view-modes.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: Source / Split / Preview view modes for split-pane formats.
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7, ADR-8. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

- **ADR-1 — Per-tab `Tab.viewMode`, not a new `FormatKind`.** View mode is a
  transient UI preference *per open document*, not a property of the format. A
  new `FormatKind: "preview"` would make a format *permanently* preview-only and
  kill editing — wrong for HTML. Instead add an optional
  `viewMode?: "source" | "split" | "preview"` to the `Tab` interface
  (`tabStore.ts:44`), mirroring the existing `editingEnabled` / `activeSchemaId`
  per-tab flags and their `updateTabById` setter. Survives tab switches; no
  format-registry or `Editor.tsx` routing change.

- **ADR-2 — Preview is a read-only render.** The Preview mode mounts the format's
  `genericPreview` / `schemaRenderer` full-width and **unmounts the CodeMirror
  SourcePane**. It is not editable. To edit, the user switches to Source or
  Split. This mirrors VS Code / Obsidian "preview" — and is the reason view mode
  is a `Tab` flag, not a `FormatKind`.

- **ADR-3 — The toggle exists only when the format has a preview.** For
  preview-less formats (txt, `kind:"viewer"` code files), `hasPreview` is false;
  the toggle is not rendered and `viewMode` is inert (the surface stays
  source-only exactly as today). The effective render is
  `hasPreview ? viewMode : "source"`, computed defensively so a stale
  `viewMode:"preview"` on a now-preview-less tab can't blank the editor.

- **ADR-4 — Default is Split, with a user-configurable global default setting.**
  A tab with no explicit `viewMode` falls back to the global
  `formats.defaultViewMode` setting (`defaults.ts:156`), which itself defaults to
  `"split"` — so existing users see no behavior change until they opt in. The
  setting is a single global choice (Source / Split / Preview) surfaced in
  `FormatsSettings.tsx`, applied when a preview-capable tab opens without a
  per-tab override. Resolution order per tab:
  `Tab.viewMode ?? formats.defaultViewMode ?? "split"`, then clamped by ADR-3
  (`hasPreview ? … : "source"`). A **per-format** default map (e.g. SVG→Preview,
  HTML→Split) is a richer follow-up (see Open Questions), not v1.

- **ADR-5 — In-surface segmented control + reused F6/Shift+F6; native menu
  deferred.** The mode control is a segmented `radiogroup` rendered inside
  `SplitPaneEditor` (top-right of the body); the keyboard path reuses the
  existing `F6`/`Shift+F6` bindings (ADR-8). Native View-menu items (Rust
  `CheckMenuItem` + menu-state sync) are **deferred** to a shared follow-up with
  #1070 so we don't ship two competing "mode" menu structures. This keeps v1
  frontend-only (no Rust menu work).

- **ADR-6 — Rendering unmounts the inactive pane.** Source mode unmounts the
  preview slot (as today when `!hasPreview`); Preview mode unmounts `SourcePane`
  (frees CodeMirror + language services + the iframe rebuild-on-keystroke cost is
  irrelevant since source isn't shown — but the preview still re-renders from
  `content`, which is unaffected by unmounting the editor). Split is unchanged.
  The persisted resize `fraction` (ADR-7) only applies in Split.

- **ADR-7 — Persist mode per-tab; leave the resize fraction ephemeral for v1.**
  Only `viewMode` persists (in `Tab`). The split `fraction` stays component-local
  for now; persisting it is orthogonal and can ride the same per-tab mechanism
  later. Documented as a follow-up to avoid scope creep.

- **ADR-8 — Reuse `F6`/`Shift+F6`; make their handlers format-aware. No new
  binding.** The existing `sourceMode` (`F6`) and `markdownSplit` (`Shift+F6`)
  handlers (`useViewShortcuts.ts:184,208`) toggle markdown-only `uiStore` state
  and are inert on split-pane tabs today. Extend both into **format-aware
  dispatchers** keyed on the focused tab's format kind:

  | Key | Markdown (base = WYSIWYG) | Split-pane (base = Split) | Else |
  |---|---|---|---|
  | `F6` | Source ⇄ WYSIWYG (existing) | Source ⇄ Split | no-op |
  | `Shift+F6` | Split ⇄ WYSIWYG (existing) | Preview ⇄ Split | no-op |

  `F6` always means "show Source." `Shift+F6` means "the alternate render
  layout" — Split for markdown (base is the full render), Preview for split-pane
  (base is already Split). Toggle-against-base gives all three split-pane modes
  from two keys and mirrors markdown's model exactly. **No** new shortcut is
  registered, so no rule-41 *addition* — but the shortcut `label`/`description`
  in `shortcuts.ts` should be generalized (they currently say "Markdown …"), and
  the docs updated. The internal ids stay `sourceMode` / `markdownSplit` (renaming
  is churn across menu-id contracts; noted, not done). **Coordination with
  #1070:** whichever lands first, these two handlers become the shared
  format-aware dispatcher; #1070's refactor must preserve the split-pane branch.
