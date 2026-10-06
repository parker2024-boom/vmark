/**
 * Source Popup View Base Class
 *
 * Abstract base class for popup views in Source mode (CodeMirror 6).
 * Provides common functionality: DOM lifecycle, store subscription,
 * keyboard navigation and click-outside handling; placement geometry and
 * listener wiring live in sourcePopupPlacement.ts.
 *
 * @module plugins/shared/SourcePopupView
 */

import type { EditorView } from "@codemirror/view";
import type { AnchorRect } from "@/utils/popupPosition";
import { handlePopupTabNavigation } from "@/utils/popupComponents";
import { getPopupHostForDom } from "./popupHostDom";
import {
  placeSourcePopup,
  setSourcePopupListeners,
  type SourcePopupListeners,
} from "./sourcePopupPlacement";
import { isImeKeyEvent } from "@/utils/imeGuard";
import type { StoreApi, PopupPositionConfig } from "./types";

// Re-export the shared popup types for convenience
export type { StoreApi, PopupPositionConfig };

/**
 * Minimal store interface for popup views.
 * Stores should have at least isOpen, anchorRect, and closePopup.
 */
export interface PopupStoreBase {
  isOpen: boolean;
  anchorRect: AnchorRect | null;
  closePopup?: () => void;
}

/**
 * Abstract base class for Source mode popup views.
 *
 * Subclasses must implement:
 * - buildContainer(): Create the popup DOM structure
 * - onShow(): Called when popup becomes visible
 * - onHide(): Called when popup is hidden
 * - extractState(): Extract relevant state for open/close detection
 *
 * @template TState - The store state type
 */
export abstract class SourcePopupView<TState extends PopupStoreBase> {
  protected container: HTMLElement;
  protected editorView: EditorView;
  protected store: StoreApi<TState>;
  protected unsubscribe: () => void;

  // Lifecycle flags
  private wasOpen = false;
  private justOpened = false;
  private host: HTMLElement | null = null;
  private lastState: TState | null = null;

  // Event handlers (bound for cleanup)
  private listeners: SourcePopupListeners;

  constructor(view: EditorView, store: StoreApi<TState>) {
    this.editorView = view;
    this.store = store;

    // Build DOM - container will be appended to host in show()
    this.container = this.buildContainer();
    this.container.style.display = "none";

    // Bind event handlers
    this.listeners = {
      clickOutside: this.handleClickOutside.bind(this),
      keydown: this.handleKeydown.bind(this),
      scroll: this.handleScroll.bind(this),
      tabNavigation: this.handleTabNavigation,
    };

    // Subscribe to store
    this.unsubscribe = store.subscribe((state) => {
      this.handleStoreState(state);
    });
  }

  private handleStoreState(state: TState): void {
    const { isOpen, anchorRect } = this.extractState(state);

    if (isOpen && anchorRect) {
      const reshow =
        this.wasOpen && this.lastState !== null && this.shouldReshow(this.lastState, state);
      if (!this.wasOpen || reshow) {
        this.show(anchorRect, state);
      }
      this.wasOpen = true;
    } else {
      if (this.wasOpen) {
        this.hide();
      }
      this.wasOpen = false;
    }
    this.lastState = state;
  }

  /**
   * Re-evaluate the current store state. Subclasses whose popup may already
   * be open at construction time call this at the end of their constructor.
   */
  protected syncFromStore(): void {
    this.handleStoreState(this.store.getState());
  }

  /**
   * Whether an already-open popup should run show() again for this state
   * change (e.g. the popup was retargeted to a different range while open).
   * Default: never re-show while open.
   */
  protected shouldReshow(_prev: TState, _state: TState): boolean {
    return false;
  }

  /**
   * Build the popup DOM container.
   * Subclasses should create and return their popup element.
   */
  protected abstract buildContainer(): HTMLElement;

  /**
   * Called when popup becomes visible.
   * Subclasses can override to set up input values, focus, etc.
   */
  protected abstract onShow(state: TState): void;

  /**
   * Called when popup is hidden.
   * Subclasses can override for cleanup.
   */
  protected abstract onHide(): void;

  /**
   * Extract isOpen and anchorRect from store state.
   * Subclasses can override if using different field names.
   */
  protected extractState(state: TState): { isOpen: boolean; anchorRect: AnchorRect | null } {
    return { isOpen: state.isOpen, anchorRect: state.anchorRect };
  }

  /**
   * Get the popup dimensions for positioning.
   * Subclasses can override for custom sizing.
   */
  protected getPopupDimensions(): PopupPositionConfig {
    return { width: 320, height: 40, gap: 6, preferAbove: true };
  }

  /** Whether show() moves focus into the popup. A popup opened by a click in
   *  editable text may decline, keeping the caret where it landed (#1448). */
  protected shouldFocusOnShow(_state: TState): boolean {
    return true;
  }

  /** Show the popup at the anchor position. */
  private show(anchorRect: AnchorRect, state: TState): void {
    // Mount to editor container if available, otherwise document.body
    this.host = getPopupHostForDom(this.editorView.dom) ?? document.body;
    if (this.container.parentElement !== this.host) {
      this.container.style.position = this.host === document.body ? "fixed" : "absolute";
      this.host.appendChild(this.container);
    }

    this.container.style.display = "flex";

    // Set guard to prevent immediate close from same click
    this.justOpened = true;
    requestAnimationFrame(() => {
      this.justOpened = false;
    });

    this.updatePosition(anchorRect);

    // Attach document/editor listeners and the Tab cycling handler
    setSourcePopupListeners(this.editorView, this.container, this.listeners, true);

    // Call subclass hook first to set up state
    this.onShow(state);
    if (!this.shouldFocusOnShow(state)) return;

    // Focus the first focusable element — deferred to escape CodeMirror's click
    // handling, so re-checked when it runs: the popup may have closed, or been
    // reopened by a click that must keep the caret in the editor (#1448).
    setTimeout(() => {
      if (!this.isVisible() || !this.shouldFocusOnShow(this.store.getState())) return;
      this.editorView.contentDOM.blur();
      this.container
        .querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ?.focus();
    }, 10);
  }

  /** Hide the popup. */
  private hide(): void {
    this.container.style.display = "none";
    this.host = null;

    // Remove event listeners
    this.detachListeners();

    // Call subclass hook
    this.onHide();
  }

  private detachListeners(): void {
    setSourcePopupListeners(this.editorView, this.container, this.listeners, false);
  }

  /** Handle Tab key for focus cycling within popup. */
  private handleTabNavigation = (e: KeyboardEvent): void => {
    if (isImeKeyEvent(e)) return;
    handlePopupTabNavigation(e, this.container);
  };

  /** Handle click outside to close popup. */
  private handleClickOutside(e: MouseEvent): void {
    if (this.justOpened) return;

    const state = this.store.getState();
    if (!state.isOpen) return;

    const target = e.target as Node;
    if (!this.container.contains(target)) {
      this.onClickOutside();
    }
  }

  /**
   * Hook for click-outside behavior. Defaults to closing the popup (discarding
   * any in-flight edits). Subclasses that hold unsaved input (math, links)
   * should override this to commit before closing — otherwise the user loses
   * the text they just typed when they click away.
   */
  protected onClickOutside(): void {
    this.closePopup();
  }

  /** Handle scroll to close popup. */
  private handleScroll(): void {
    if (this.store.getState().isOpen) {
      this.closePopup();
    }
  }

  /** Handle Escape key to close popup. */
  private handleKeydown(e: KeyboardEvent): void {
    if (isImeKeyEvent(e)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      this.closePopup();
      this.editorView.focus();
    }
  }

  /** Close the popup via store action. */
  protected closePopup(): void {
    const state = this.store.getState();
    if (typeof state.closePopup === "function") {
      state.closePopup();
    }
  }

  /** Focus the editor. */
  protected focusEditor(): void {
    this.editorView.focus();
  }

  /**
   * Update popup position if anchor has moved.
   * Call this when the document changes while popup is open.
   */
  protected updatePosition(anchorRect: AnchorRect): void {
    if (this.container.style.display === "none") return;
    placeSourcePopup(this.editorView, this.container, this.host, anchorRect, this.getPopupDimensions());
  }

  /** Check if popup is currently visible. */
  protected isVisible(): boolean {
    return this.container.style.display !== "none";
  }

  /** Destroy the popup view and clean up. */
  destroy(): void {
    this.unsubscribe();
    this.detachListeners();
    this.container.remove();
  }
}
