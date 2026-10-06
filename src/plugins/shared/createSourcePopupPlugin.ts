/**
 * Source Popup Plugin Factory — creates CodeMirror 6 plugins that manage popup
 * views: plugin lifecycle, view creation/destruction, and click detection.
 * @module plugins/shared/createSourcePopupPlugin
 */

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { AnchorRect } from "@/utils/popupPosition";
import type { SourcePopupView, StoreApi, PopupStoreBase } from "./SourcePopupView";
import { getAnchorRectFromRange } from "./sourcePopupUtils";

/** Configuration for popup trigger detection. */
export interface PopupTriggerConfig<TState extends PopupStoreBase, TData extends object = object> {
  /** Store API for the popup. */
  store: StoreApi<TState>;

  /** Create the popup view instance. */
  createView: (view: EditorView, store: StoreApi<TState>) => SourcePopupView<TState>;

  /**
   * Detect if cursor/click is on a trigger element.
   * Return the range if detected, null otherwise.
   */
  detectTrigger: (view: EditorView) => { from: number; to: number } | null;

  /**
   * Detect trigger for a specific document position (hover/click).
   * If omitted, detectTrigger is used.
   */
  detectTriggerAtPos?: (
    view: EditorView,
    pos: number
  ) => { from: number; to: number } | null;

  /**
   * Extract data from the detected range for the popup.
   * Called when trigger is detected to populate the store.
   */
  extractData: (view: EditorView, range: { from: number; to: number }) => TData;

  /** Custom open handler for stores that don't use object payloads. */
  openPopup?: (context: {
    view: EditorView;
    range: { from: number; to: number };
    anchorRect: AnchorRect;
    data: TData;
  }) => void;

  /** Optional hook called before opening the popup. */
  onOpen?: (context: {
    popupView: SourcePopupView<TState>;
    view: EditorView;
    range: { from: number; to: number };
    anchorRect: AnchorRect;
    data: TData;
  }) => void;

  /** Whether to trigger on click (default: true). */
  triggerOnClick?: boolean;

  /**
   * Whether to trigger on hover (default: false).
   * If true, hoverDelay should be specified.
   */
  triggerOnHover?: boolean;

  /** Delay in ms before showing popup on hover (default: 300). */
  hoverDelay?: number;

  /** Delay in ms before hiding popup when mouse leaves (default: 100). */
  hoverHideDelay?: number;
}

/**
 * Create a CodeMirror 6 plugin for managing a popup.
 *
 * @template TState - The popup store state type
 * @param config - Popup configuration
 * @returns ViewPlugin for use in CM6 extensions
 */
export function createSourcePopupPlugin<TState extends PopupStoreBase, TData extends object = object>(
  config: PopupTriggerConfig<TState, TData>
) {
  const {
    store,
    createView,
    detectTrigger,
    detectTriggerAtPos,
    extractData,
    openPopup,
    onOpen,
    triggerOnClick = true,
    triggerOnHover = false,
    hoverDelay = 300,
    hoverHideDelay = 100,
  } = config;

  return ViewPlugin.fromClass(
    class SourcePopupPluginInstance {
      private popupView: SourcePopupView<TState>;
      private hoverTimeout: ReturnType<typeof setTimeout> | null = null;
      private hideTimeout: ReturnType<typeof setTimeout> | null = null;
      private isMouseDown = false;
      private lastHoverRange: { from: number; to: number } | null = null;
      private readonly dom: HTMLElement;

      constructor(view: EditorView) {
        this.popupView = createView(view, store);
        this.dom = view.dom;

        // Set up click handler
        if (triggerOnClick) {
          view.dom.addEventListener("click", this.handleClick);
        }

        // Set up hover handlers
        if (triggerOnHover) {
          view.dom.addEventListener("mousemove", this.handleMouseMove);
          view.dom.addEventListener("mouseleave", this.handleMouseLeave);
          view.dom.addEventListener("mousedown", this.handleMouseDown);
          view.dom.addEventListener("mouseup", this.handleMouseUp);
        }
      }

      update(update: ViewUpdate) {
        // Close popup on selection change (cursor moved away)
        if (update.selectionSet && !update.docChanged) {
          const state = store.getState();
          if (state.isOpen) {
            // Check if cursor is still in the trigger range
            const range = detectTrigger(update.view);
            if (!range) {
              // Cursor moved out of trigger - close after a short delay
              // to allow clicking popup buttons
              if (this.hideTimeout) clearTimeout(this.hideTimeout);
              this.hideTimeout = setTimeout(() => {
                if (store.getState().isOpen && !detectTrigger(update.view)) {
                  store.getState().closePopup?.();
                }
              }, 100);
            }
          }
        }
      }

      destroy() {
        this.popupView.destroy();

        // CodeMirror destroys a plugin on reconfiguration while view.dom lives
        // on, so the listeners must go with the instance that owns them.
        if (triggerOnClick) {
          this.dom.removeEventListener("click", this.handleClick);
        }
        if (triggerOnHover) {
          this.dom.removeEventListener("mousemove", this.handleMouseMove);
          this.dom.removeEventListener("mouseleave", this.handleMouseLeave);
          this.dom.removeEventListener("mousedown", this.handleMouseDown);
          this.dom.removeEventListener("mouseup", this.handleMouseUp);
        }

        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
        if (this.hideTimeout) clearTimeout(this.hideTimeout);
      }

      private handleClick = (e: MouseEvent) => {
        const view = this.popupView["editorView"];
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return;

        // Detect trigger at click position
        const range = this.detectTriggerAtPos(view, pos);
        if (!range) return;

        // Check if click is within the detected range
        if (pos < range.from || pos > range.to) return;

        this.openAt(view, range);
      };

      /** Extract the trigger's data and open the popup anchored to its range. */
      private openAt(view: EditorView, range: { from: number; to: number }) {
        const anchorRect = getAnchorRectFromRange(view, range.from, range.to);
        if (!anchorRect) return;

        const data = extractData(view, range);
        onOpen?.({ popupView: this.popupView, view, range, anchorRect, data });
        if (openPopup) {
          openPopup({ view, range, anchorRect, data });
          return;
        }

        const openFn = (store.getState() as TState & { openPopup?: (data: unknown) => void })
          .openPopup;
        if (typeof openFn === "function") {
          openFn({ ...data, anchorRect });
        }
      }

      private handleMouseMove = (e: MouseEvent) => {
        // Don't show hover popup while selecting
        if (this.isMouseDown) {
          this.cancelHoverTimeout();
          return;
        }

        const view = this.popupView["editorView"];
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) {
          this.cancelHoverTimeout();
          return;
        }

        // Detect trigger at mouse position
        // For hover, we check based on position, not selection
        const range = this.detectTriggerAtPos(view, pos);
        if (!range) {
          this.cancelHoverTimeout();
          this.lastHoverRange = null;
          return;
        }

        // If same range as before, don't restart timer
        if (
          this.lastHoverRange &&
          this.lastHoverRange.from === range.from &&
          this.lastHoverRange.to === range.to
        ) {
          return;
        }

        this.lastHoverRange = range;
        this.cancelHoverTimeout();

        // Start hover timer
        this.hoverTimeout = setTimeout(() => {
          // Double-check position is still valid
          if (this.isMouseDown) return;
          this.openAt(view, range);
        }, hoverDelay);
      };

      private handleMouseLeave = () => {
        this.cancelHoverTimeout();
        this.lastHoverRange = null;

        // Start hide timer
        if (store.getState().isOpen) {
          this.hideTimeout = setTimeout(() => {
            // Check if mouse is now over the popup
            // If so, don't close
            const popupEl = this.popupView["container"];
            if (popupEl && popupEl.matches(":hover")) {
              return;
            }
            store.getState().closePopup?.();
          }, hoverHideDelay);
        }
      };

      private handleMouseDown = () => {
        this.isMouseDown = true;
        this.cancelHoverTimeout();
      };

      private handleMouseUp = () => {
        this.isMouseDown = false;
      };

      private cancelHoverTimeout() {
        if (this.hoverTimeout) {
          clearTimeout(this.hoverTimeout);
          this.hoverTimeout = null;
        }
        if (this.hideTimeout) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = null;
        }
      }

      /**
       * Detect trigger at a specific position (for hover).
       * This is a workaround since detectTrigger uses selection.
       */
      private detectTriggerAtPos(
        view: EditorView,
        pos: number
      ): { from: number; to: number } | null {
        if (detectTriggerAtPos) {
          return detectTriggerAtPos(view, pos);
        }
        const range = detectTrigger(view);
        if (!range) return null;
        if (pos < range.from || pos > range.to) return null;
        return range;
      }
    }
  );
}

