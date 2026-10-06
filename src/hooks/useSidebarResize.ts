/**
 * Sidebar Resize Hook
 *
 * Purpose: Resize handlers for the sidebar panel — drag (mouse) and
 *   keyboard arrows (a11y). Clamps width to min/max bounds.
 *
 * Key decisions:
 *   - A drag does NOT write the store per pointer move. `sidebarWidth` is read
 *     by the composition root, so every write re-rendered the whole layout —
 *     editor, terminal, overlays — once per mousemove. During the gesture the
 *     live width is painted straight onto the three places the layout sizes
 *     itself from, and the store is written once, when the drag ends.
 *   - The paint targets are the elements React itself sized (the sidebar
 *     column, the shell's aside, the shell's `--shell-side-width`). The commit
 *     re-renders them to the same values, so the hand-off is invisible;
 *     `App.sidebarDrag.test.tsx` pins that equality against the real shell.
 *   - Every way a drag can end commits the width the user was looking at:
 *     release, window blur, a new press, and the handle unmounting mid-drag.
 *     A press with no movement commits nothing.
 *   - Listener lifetime belongs to `useDocumentDrag`.
 *
 * @coordinates-with uiStore.ts — reads/writes sidebarWidth
 * @coordinates-with hooks/useDocumentDrag.ts — document listener lifetime
 * @coordinates-with App.tsx — renders `.app-sidebar-stack__sidebar` around the handle
 * @coordinates-with shell/AppShell.tsx — renders `.app-shell__sidebar` and `--shell-side-width`
 * @module hooks/useSidebarResize
 */

import { useCallback, useEffect } from "react";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useUIStore } from "@/stores/uiStore";
import { useDocumentDrag } from "@/hooks/useDocumentDrag";

/** Sidebar width constraints in pixels — ONE owner: the store's canonical
 * bounds, so Home/End and the ARIA range never expose a value the store
 * would immediately reject. */
export const MIN_SIDEBAR_WIDTH = SIDEBAR_MIN_WIDTH;
export const MAX_SIDEBAR_WIDTH = SIDEBAR_MAX_WIDTH;
/** Keyboard resize step per arrow press */
const KEYBOARD_RESIZE_STEP = 8;
/** Larger step when Shift is held */
const KEYBOARD_RESIZE_STEP_LARGE = 32;
/** The editor's keep-alive floor: rail + margins + a readable column. */
const EDITOR_MIN_WIDTH = 480;

/** Clamp a width to the store's bounds AND the live viewport — a fixed max
 * could swallow the editor on a narrow window. */
function clampWidth(width: number): number {
  const viewportMax = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - EDITOR_MIN_WIDTH);
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewportMax, width));
}

/**
 * Returns a painter that shows `width` in the layout around `handle` without
 * going through React.
 *
 * The shell's aside is wider than the sidebar column by whatever else sits in
 * the leading card (the workspace rail, the card's gutters). That remainder
 * does not change during a drag, so it is read once from what React rendered
 * rather than re-derived here.
 */
function createLiveWidthPainter(handle: HTMLElement, startWidth: number): (width: number) => void {
  const column = handle.closest<HTMLElement>(".app-sidebar-stack__sidebar");
  const aside = handle.closest<HTMLElement>(".app-shell__sidebar");
  const shell = handle.closest<HTMLElement>(".app-shell");
  const asideExtra = aside ? Number.parseFloat(aside.style.width) - startWidth : Number.NaN;

  return (width) => {
    if (column) column.style.width = `${width}px`;
    if (aside && Number.isFinite(asideExtra)) {
      const side = `${asideExtra + width}px`;
      aside.style.width = side;
      aside.style.minWidth = side;
      shell?.style.setProperty("--shell-side-width", side);
    }
    handle.setAttribute("aria-valuenow", String(width));
  };
}

/**
 * Hook for handling sidebar resize via drag (mouse) and keyboard arrows.
 *
 * Returns both:
 * - `handleResizeStart` — onMouseDown handler for drag. The layout follows the
 *   pointer live; the store is written once, when the drag ends.
 * - `handleResizeKeyDown` — onKeyDown handler: ArrowLeft/Right step by
 *   KEYBOARD_RESIZE_STEP (Shift = KEYBOARD_RESIZE_STEP_LARGE); Home/End
 *   clamp to MIN/MAX
 */
export function useSidebarResize() {
  const drag = useDocumentDrag();

  // The viewport cap must hold outside of interaction too: a restored wide
  // sidebar would otherwise keep its width when the WINDOW narrows. Reclamp
  // the stored width on resize (and once on mount).
  useEffect(() => {
    const reclamp = () => {
      const current = useUIStore.getState().sidebarWidth;
      const next = clampWidth(current);
      if (next !== current) useUIStore.getState().setSidebarWidth(next);
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      // A press can arrive while a previous drag is still attached (its
      // mouseup was delivered outside the window). End it first, so its width
      // is committed before this drag reads its starting point.
      drag.stop();

      const startX = e.clientX;
      const startWidth = useUIStore.getState().sidebarWidth;
      const paint = createLiveWidthPainter(e.currentTarget, startWidth);
      let liveWidth: number | null = null;

      drag.start({
        cursor: "col-resize",
        onMove: (move) => {
          const width = clampWidth(startWidth + move.clientX - startX);
          if (width === liveWidth) return;
          liveWidth = width;
          paint(width);
        },
        onEnd: () => {
          if (liveWidth !== null) useUIStore.getState().setSidebarWidth(liveWidth);
        },
      });
    },
    [drag]
  );

  // Keyboard resize for screen-reader and keyboard-only users.
  // Arrows step by KEYBOARD_RESIZE_STEP (Shift = LARGE); Home/End clamp.
  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const current = useUIStore.getState().sidebarWidth;
    const step = e.shiftKey ? KEYBOARD_RESIZE_STEP_LARGE : KEYBOARD_RESIZE_STEP;
    let next: number;

    switch (e.key) {
      case "ArrowLeft":
        next = current - step;
        break;
      case "ArrowRight":
        next = current + step;
        break;
      case "Home":
        next = MIN_SIDEBAR_WIDTH;
        break;
      case "End":
        next = MAX_SIDEBAR_WIDTH;
        break;
      default:
        return;
    }

    e.preventDefault();
    useUIStore.getState().setSidebarWidth(clampWidth(next));
  }, []);

  return { handleResizeStart, handleResizeKeyDown };
}
