/**
 * Footnote Popup Tiptap Extension
 *
 * Purpose: Manages the footnote hover popup in WYSIWYG mode — shows footnote content
 * on hover/click of footnote references, with editing, deletion, and renumbering support.
 *
 * Pipeline: hover/click on [^n] → show popup with definition content → edit inline
 *         → delete → renumber remaining footnotes → cleanup orphaned definitions
 *
 * Key decisions:
 *   - Hover has a delay (150ms open, 100ms close) to avoid flickering on mouse movement
 *   - Hover state is per-EditorView (WeakMap-keyed) so multi-window / tear-off editors
 *     do not race on shared module timers.
 *   - Popup uses FootnotePopupView (DOM-based, not React) for performance
 *   - appendTransaction handles footnote deletion + renumbering in a single atomic step;
 *     it lives in cleanupOnEdit.ts, which also keeps it from reading the document on
 *     edits that cannot have removed a reference
 *   - Footnote references and definitions are bidirectionally linked for navigation
 *
 * @coordinates-with FootnotePopupView.ts — DOM construction and event handling for the popup
 * @coordinates-with cleanupOnEdit.ts — the appendTransaction: cleanup after a reference is removed
 * @coordinates-with tiptapDomUtils.ts — DOM traversal for finding footnote elements
 * @coordinates-with tiptapNodes.ts — footnoteReference and footnoteDefinition node types
 * @coordinates-with stores/footnotePopupStore.ts — popup visibility and position state
 * @module plugins/footnotePopup/tiptap
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { StoreApi } from "@/plugins/shared/types";
import type { FootnotePopupState } from "@/plugins/shared/popupPorts";
import { HOVER_OPEN_DELAY_MS, HOVER_CLOSE_DELAY_MS, getHoverState, clearHoverTimeout, clearCloseTimeout, resetHoverState } from "./hoverState";
import { FootnotePopupView } from "./FootnotePopupView";
import { createFootnoteCleanupOnEdit } from "./cleanupOnEdit";
import { findFootnoteDefinition, findFootnoteReference, getFootnoteDefFromTarget, getFootnoteRefFromTarget, scrollToPosition } from "./tiptapDomUtils";
import { requirePort } from "@/plugins/shared/requirePort";
import "./footnote-popup.css";

export const footnotePopupPluginKey = new PluginKey("footnotePopup");

function handleMouseOver(store: StoreApi<FootnotePopupState>, view: EditorView, event: MouseEvent): boolean {
  const refElement = getFootnoteRefFromTarget(event.target);
  if (!refElement) return false;
  const state = getHoverState(view);
  if (state.currentRefElement === refElement) return false;

  clearCloseTimeout(state);
  clearHoverTimeout(state);

  state.hoverTimeout = setTimeout(() => {
    const label = refElement.getAttribute("data-label");
    if (!label) return;

    state.currentRefElement = refElement;

    const definition = findFootnoteDefinition(view, label);
    const content = definition?.content ?? "Footnote not found";
    const defPos = definition?.pos ?? null;
    const refPos = findFootnoteReference(view, label);

    const domRect = refElement.getBoundingClientRect();
    store.getState().openPopup(
      label, content,
      { top: domRect.top, left: domRect.left, bottom: domRect.bottom, right: domRect.right },
      defPos, refPos
    );
  }, HOVER_OPEN_DELAY_MS);

  return false;
}

function handleMouseOut(store: StoreApi<FootnotePopupState>, view: EditorView, event: MouseEvent): boolean {
  const relatedTarget = event.relatedTarget as HTMLElement | null;

  if (relatedTarget?.closest(".footnote-popup")) return false;
  if (relatedTarget && getFootnoteRefFromTarget(relatedTarget)) return false;

  const state = getHoverState(view);
  clearHoverTimeout(state);
  state.currentRefElement = null;

  clearCloseTimeout(state);
  state.closeTimeout = setTimeout(() => {
    const popup = document.querySelector(".footnote-popup");
    if (!popup?.matches(":hover")) {
      store.getState().closePopup();
    }
  }, HOVER_CLOSE_DELAY_MS);

  return false;
}

function handleMouseDown(_view: EditorView, event: MouseEvent): boolean {
  const refElement = getFootnoteRefFromTarget(event.target);
  return Boolean(refElement);
}

function handleKeyDown(store: StoreApi<FootnotePopupState>, _view: EditorView, event: KeyboardEvent): boolean {
  if (event.key === "Escape") {
    const { isOpen } = store.getState();
    if (isOpen) {
      // Only close if not in editing mode (textarea focused)
      const popup = document.querySelector(".footnote-popup");
      if (popup && !popup.classList.contains("editing")) {
        store.getState().closePopup();
        return true;
      }
    }
  }
  return false;
}

function handleClick(_store: StoreApi<FootnotePopupState>, view: EditorView, _pos: number, event: MouseEvent): boolean {
  const refElement = getFootnoteRefFromTarget(event.target);
  if (refElement) {
    const label = refElement.getAttribute("data-label");
    if (label) {
      const definition = findFootnoteDefinition(view, label);
      if (definition?.pos !== undefined) {
        scrollToPosition(view, definition.pos);
        return true;
      }
    }
  }

  const defElement = getFootnoteDefFromTarget(event.target);
  if (defElement) {
    const label = defElement.getAttribute("data-label");
    if (label) {
      const refPos = findFootnoteReference(view, label);
      if (refPos !== null) {
        scrollToPosition(view, refPos);
        return true;
      }
    }
  }

  return false;
}

class FootnotePopupPluginView {
  private popupView: FootnotePopupView;
  private view: EditorView;
  private lastSelectedRefPos: number | null = null;

  constructor(view: EditorView, private store: StoreApi<FootnotePopupState>) {
    this.view = view;
    this.popupView = new FootnotePopupView(view, store);
  }

  update() {
    this.popupView.update();
    this.checkSelectionForFootnote();
  }

  private checkSelectionForFootnote() {
    const { selection } = this.view.state;

    // Check if selection is a NodeSelection on a footnote_reference
    if (selection instanceof NodeSelection) {
      const node = selection.node;
      if (node.type.name === "footnote_reference") {
        const pos = selection.from;

        // Avoid re-opening for the same position
        if (this.lastSelectedRefPos === pos) return;
        this.lastSelectedRefPos = pos;

        /* v8 ignore next -- @preserve footnote_reference nodes always have a label attr */
        const label = String(node.attrs.label ?? "");
        const definition = findFootnoteDefinition(this.view, label);
        const content = definition?.content ?? "Footnote not found";
        const defPos = definition?.pos ?? null;

        // Get the DOM element for positioning
        const dom = this.view.nodeDOM(pos) as HTMLElement | null;
        if (dom) {
          const domRect = dom.getBoundingClientRect();
          this.store.getState().openPopup(
            label, content,
            { top: domRect.top, left: domRect.left, bottom: domRect.bottom, right: domRect.right },
            defPos, pos
          );
        }
        return;
      }
    }

    // Selection moved away from footnote - close popup if it was opened via selection
    if (this.lastSelectedRefPos !== null) {
      this.lastSelectedRefPos = null;
      // Only close if popup is open and not in editing mode
      const popup = document.querySelector(".footnote-popup");
      if (popup && !popup.classList.contains("editing")) {
        this.store.getState().closePopup();
      }
    }
  }

  destroy() {
    resetHoverState(this.view);
    this.popupView.destroy();
  }
}

/** Options for the footnote-popup extension. */
export interface FootnotePopupOptions {
  /** The popup state this plugin drives — a PORT, not the app's store. */
  store: StoreApi<FootnotePopupState> | undefined;
}

export const footnotePopupExtension = Extension.create<FootnotePopupOptions>({
  name: "footnotePopup",
  addOptions() {
    return { store: undefined };
  },
  addProseMirrorPlugins() {
    const store = requirePort(this.options.store, "footnotePopupExtension", "store");
    return [
      new Plugin({
        key: footnotePopupPluginKey,
        view(editorView) {
          const popup = new FootnotePopupPluginView(editorView, store);
          return {
            update: () => popup.update(),
            destroy: () => popup.destroy(),
          };
        },
        props: {
          // ProseMirror fixes these signatures, so the store rides as a
          // leading parameter and is bound here.
          handleClick: (v, pos, e) => handleClick(store, v, pos, e),
          handleKeyDown: (v, e) => handleKeyDown(store, v, e),
          handleDOMEvents: {
            mousedown: handleMouseDown,
            mouseover: (v, e) => handleMouseOver(store, v, e),
            mouseout: (v, e) => handleMouseOut(store, v, e),
          },
        },
        appendTransaction: createFootnoteCleanupOnEdit(),
      }),
    ];
  },
});
