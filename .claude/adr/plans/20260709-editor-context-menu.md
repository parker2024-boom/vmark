# Decisions — Editor Right-Click Context Menu (Issue #1111)

> Plan: `dev-docs/plans/20260709-editor-context-menu.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the editor context menu (`src/components/Editor/EditorContextMenu/`, `src-tauri/src/webview_edit.rs`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1 — Custom HTML menu, not Tauri native `Menu.popup()`

Tauri v2 can pop native menus from JS, and `PredefinedMenuItem` would give
native clipboard roles for free. Rejected because: (a) all six existing
VMark context menus are custom HTML — a native menu would be the visual odd
one out; (b) context-aware checkmarks/disabled states need synchronous
editor-state reads, not IPC round-trips per popup; (c) custom menus are
unit-testable with Vitest and themeable with design tokens; (d) the one
native advantage (clipboard fidelity) is recovered by ADR-3.

### ADR-2 — Reuse the action layer via an extracted `dispatchEditorAction`

The menu must not become a third dispatch path. Extract the "resolve mode →
build ToolbarContext → call adapter" block from `UniversalToolbar.handleAction`
into `src/plugins/toolbarActions/dispatch.ts`; the toolbar and the context
menu both call it. The helper also applies the two protections the menu
would otherwise silently lose (Codex finding): the
`isMenuActionAllowedForActiveFormat` policy gate and forced-source
resolution. `useUnifiedMenuCommands` keeps its own dispatch (retry/IME-queue
logic the menu doesn't need); aligning it is an optional follow-up. Source
dispatches from the menu wrap in `runOrQueueCodeMirrorAction` (IME guard),
same as the unified-menu path.

### ADR-3 — Clipboard: native responder-chain trigger on macOS, plugin fallback elsewhere

New Tauri command `trigger_webview_edit(action: "cut"|"copy"|"paste"|"selectAll")`:

- **macOS**: `NSApp sendAction:` with the matching selector (`paste:` etc.)
  to the first responder — exactly what the Edit menu's `PredefinedMenuItem`s
  do. Paste flows through the normal webview paste event and all existing
  paste plugins (`htmlPaste`, `markdownPaste`, `codePaste`, CM `smartPaste`)
  with full HTML/image fidelity. One paste pipeline, zero forks.
- **Focus/selection contract** (Codex High finding): the responder chain
  targets the *first responder*, so the editor — not a menu button — must own
  focus when the command fires. The menu closes, calls the surface's
  `focus()` (`editorView.focus()` / `cmView.focus()`; both PM and CM restore
  their DOM selection on refocus), and only then invokes the command.
  Keyboard navigation may move real focus to menu items (ARIA requirement);
  pointer activation uses `mousedown.preventDefault()` so mouse clicks never
  steal focus at all. Phase 0 validates this exact close→refocus→sendAction
  path with a throwaway menu, not just a bare `sendAction` probe.
- **Windows/Linux** (best-effort per cross-platform policy): cut/copy via
  `document.execCommand` (functional in WebView2/WebKitGTK; goes through
  `markdownCopy`'s serializer). Paste fallback, exact APIs per surface:
  WYSIWYG → clipboard-manager `readText()` → `editorView.pasteText(text)`
  (prosemirror-view; verify availability in the pinned version during
  Phase 0, else synthesize a paste `ClipboardEvent` on the contenteditable);
  Source → `cmView.dispatch(cmView.state.replaceSelection(text))`. Image
  paste fallback reuses the existing image-save helper from the
  `markdownPaste`/`smartPaste` image path — no new persistence code.

The command rejects unknown action strings (`Result<(), String>`).

### ADR-4 — `editorContextMenu` slice in `popupStore` (not a standalone store)

Popup state was consolidated into `usePopupStore` (15 slices; the old
`imageContextMenuStore` is a `createSliceShim` projection). The new menu
adds an `editorContextMenu` slice (`slices.ts` initial state + `types.ts`
interface + open/close actions in an action-group file) holding
`{ isOpen, position, snapshot }`. New code imports `usePopupStore` directly;
no legacy shim is created. One `<EditorContextMenu/>` singleton subscribes.

### ADR-5 — Trigger precedence: guards before ownership, order specified

The generic triggers must not steal events from the table/image menus
(which `preventDefault()` but do not `stopPropagation()`):

- **WYSIWYG**: the trigger is a ProseMirror `handleDOMEvents.contextmenu`
  in a new plugin registered *after* `tableUI` in the extension assembly.
  Guard order: bail if `event.defaultPrevented`; bail if `isInTable(view)`;
  bail if the event target closest-matches an image node view. Only then
  claim the event.
- **Source**: CM `ViewPlugin` `eventHandlers.contextmenu`. Check
  `getSourceTableInfo` at the click position *before* moving the cursor
  (the source-table menu moves the cursor first today — the generic handler
  must not repeat that pattern); bail if the table menu owns the region or
  `event.defaultPrevented`.
- Registration-order regression tests cover both "generic before specific"
  and "specific before generic" orderings.
- `useReloadGuard`'s global suppressor stays as the outermost fallback for
  non-editor surfaces. Dev mode keeps the native menu outside the editor.

### ADR-6 — Explicit item descriptors + normalized context snapshot

Two action vocabularies coexist (Codex High finding): `TOOLBAR_GROUPS` uses
adapter strings (`heading:1`, `insertCodeBlock`) while `ACTION_DEFINITIONS`
uses canonical IDs (`setHeading`, `codeBlock`). The menu therefore defines
its own explicit descriptor per item — nothing is derived blindly:

```ts
interface ContextMenuItemDescriptor {
  id: string;                 // stable menu item id
  labelKey: string;           // editor:contextMenu.* i18n key
  adapterAction: string;      // performXToolbarAction vocabulary
  actionId?: ActionId;        // canonical id, for supports{} filtering
  shortcutId?: string;        // settingsStore shortcut id (explicit — toolbar
                              // ids like "h1" do NOT match shortcut ids)
  enabledIn: EnabledContext[];
}
```

A dev-time consistency test asserts every descriptor's `adapterAction` is
accepted by both adapters (or flagged wysiwyg/source-only) and every
`shortcutId` exists in the shortcut definitions — drift fails CI.

`buildEditorContextMenu(snapshot): MenuSection[]` is a pure function over a
normalized snapshot — the fixed contract between per-surface providers
(Phases 2–3) and the builder (Phase 1), which is what lets Phase 1 test all
contexts before the providers exist:

```ts
interface EditorContextMenuSnapshot {
  surface: "wysiwyg" | "source";
  selectionEmpty: boolean;
  multiSelection: boolean;
  formatPolicy: "markdown" | "restricted"; // menuPolicy verdict, precomputed
  block: { type: "paragraph" | "heading" | "codeblock" | "other"; headingLevel?: number };
  list: { type: "bullet" | "ordered" | "task" } | null;
  inBlockquote: boolean;
  link: { href: string | null } | null;    // null = not on a link;
                                            // href null = target unresolved
  activeActions: ReadonlySet<string>;       // adapterAction strings currently active
  disabledActions: ReadonlySet<string>;     // from getToolbarItemState
}
```

**Hide vs disable policy** (explicit): a *section* whose items are all
inapplicable to the snapshot is hidden (e.g. inline-format + block sections
inside a code block or under `formatPolicy: "restricted"`); an individually
inapplicable item inside an otherwise-applicable section renders disabled.
The policy lives in the builder, not in `enableRules` (which only knows
per-item disabled state).
