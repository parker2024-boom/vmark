/**
 * Source popup placement and listener wiring
 *
 * Purpose: the geometry and event wiring behind SourcePopupView, kept out of
 * the base class — where an open popup goes for a given anchor, and which
 * document and editor listeners it holds while open.
 *
 * Key decisions:
 *   - Positions are computed in viewport coordinates, then converted to
 *     host-relative ones when the popup is mounted inside the editor container
 *     (a popup on document.body is position: fixed and keeps viewport values).
 *   - Attach and detach go through one function so the two lists cannot drift.
 *
 * @coordinates-with SourcePopupView.ts — the base class that calls these
 * @coordinates-with sourcePopupUtils.ts — editor bounds for clamping
 * @module plugins/shared/sourcePopupPlacement
 */
import type { EditorView } from "@codemirror/view";
import { calculatePopupPosition, type AnchorRect } from "@/utils/popupPosition";
import { toHostCoordsForDom } from "./popupHostDom";
import type { PopupPositionConfig } from "./types";
import { getEditorBounds } from "./sourcePopupUtils";

/** Place `container` next to `anchorRect`, clamped to the editor bounds. */
export function placeSourcePopup(
  view: EditorView,
  container: HTMLElement,
  host: HTMLElement | null,
  anchorRect: AnchorRect,
  dimensions: PopupPositionConfig,
): void {
  const { top, left } = calculatePopupPosition({
    anchor: anchorRect,
    popup: { width: dimensions.width, height: dimensions.height },
    bounds: getEditorBounds(view),
    gap: dimensions.gap ?? 6,
    preferAbove: dimensions.preferAbove ?? true,
  });

  // Convert to host-relative coordinates if mounted inside editor container
  const position =
    host && host !== document.body ? toHostCoordsForDom(host, { top, left }) : { top, left };
  container.style.top = `${position.top}px`;
  container.style.left = `${position.left}px`;
}

/** The handlers an open Source popup listens with. */
export interface SourcePopupListeners {
  clickOutside: (e: MouseEvent) => void;
  keydown: (e: KeyboardEvent) => void;
  scroll: () => void;
  tabNavigation: (e: KeyboardEvent) => void;
}

/** Attach (`attach = true`) or detach the listeners an open popup holds. */
export function setSourcePopupListeners(
  view: EditorView,
  container: HTMLElement,
  listeners: SourcePopupListeners,
  attach: boolean,
): void {
  const scrollRoot = view.dom.closest(".editor-container");
  if (attach) {
    document.addEventListener("mousedown", listeners.clickOutside);
    document.addEventListener("keydown", listeners.keydown);
    scrollRoot?.addEventListener("scroll", listeners.scroll, true);
    container.addEventListener("keydown", listeners.tabNavigation);
  } else {
    document.removeEventListener("mousedown", listeners.clickOutside);
    document.removeEventListener("keydown", listeners.keydown);
    scrollRoot?.removeEventListener("scroll", listeners.scroll, true);
    container.removeEventListener("keydown", listeners.tabNavigation);
  }
}
