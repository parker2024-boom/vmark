/**
 * Tab drag geometry
 *
 * Purpose: the pure measurements behind a tab drag — where a dragged tab would
 * drop, whether the pointer has left the tab bar far enough to detach, and how
 * fast the tab list should auto-scroll near its edges.
 *
 * Key decisions:
 *   - No state and no listeners: every function reads the DOM rects it is
 *     given and returns a number, so the gesture hook stays about the gesture.
 *   - The synthetic workspace tab is not a drop target and is skipped.
 *
 * @coordinates-with hooks/useTabDragOut.ts — the gesture state machine that calls these
 * @module utils/tabDragGeometry
 */

/** Vertical distance (px) outside the tab bar to trigger drag-out. */
const DRAG_OUT_THRESHOLD = 40;
const AUTO_SCROLL_EDGE_PX = 28;
const AUTO_SCROLL_MAX_STEP = 14;

/** Screen and viewport coordinates captured at the moment a tab is dragged out. */
export interface DragOutPoint {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

/** Get the index where a dragged tab should be inserted based on cursor X. */
export function calcDropIndex(bar: HTMLElement, clientX: number): number {
  const tablist = bar.querySelector("[role='tablist']");
  if (!tablist) return -1;

  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>("[role='tab']:not([data-workspace-tab])")); // exclude synthetic workspace tab
  if (tabs.length === 0) return -1;

  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (clientX < midX) {
      return i;
    }
  }
  return tabs.length;
}

/** True once the pointer has left the tab bar by more than the drag-out threshold, above or below. */
export function isOutsideVerticalBand(barTop: number, barBottom: number, clientY: number): boolean {
  return clientY > barBottom + DRAG_OUT_THRESHOLD || clientY < barTop - DRAG_OUT_THRESHOLD;
}

/** Pixels to scroll the tab list this move: negative near its left edge, positive near its right, 0 elsewhere. */
export function calcAutoScrollDelta(tablistRect: DOMRect, clientX: number): number {
  const leftEdge = tablistRect.left + AUTO_SCROLL_EDGE_PX;
  const rightEdge = tablistRect.right - AUTO_SCROLL_EDGE_PX;
  if (clientX < leftEdge) {
    const intensity = Math.min(1, (leftEdge - clientX) / AUTO_SCROLL_EDGE_PX);
    return -Math.ceil(AUTO_SCROLL_MAX_STEP * intensity);
  }
  if (clientX > rightEdge) {
    const intensity = Math.min(1, (clientX - rightEdge) / AUTO_SCROLL_EDGE_PX);
    return Math.ceil(AUTO_SCROLL_MAX_STEP * intensity);
  }
  return 0;
}

/** The viewport and screen coordinates of a pointer event. */
export function toPoint(ev: PointerEvent): DragOutPoint {
  return {
    clientX: ev.clientX,
    clientY: ev.clientY,
    screenX: ev.screenX,
    screenY: ev.screenY,
  };
}


