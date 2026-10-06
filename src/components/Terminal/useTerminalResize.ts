/**
 * useTerminalResize
 *
 * Purpose: Hook for drag-to-resize on the terminal panel's edge. Works for all
 * four panel positions (top/bottom/left/right); the grow direction is derived
 * from the position (see the hook doc below).
 *
 * Key decisions:
 *   - The document listeners belong to `useDocumentDrag`, which removes them on
 *     mouseup, window blur and unmount, and ends a drag that is still attached
 *     when the next press arrives (a mouseup delivered outside the window never
 *     reaches the document), so listeners never stack.
 *   - Grow sign flips per side: right/bottom grow on negative client delta;
 *     left/top grow on positive (their handle is on the far edge).
 *   - Sets document.body cursor during drag and disables text selection.
 *   - Caps the live size at 80% of available space (TERMINAL_MAX_RATIO); the
 *     store setters only enforce the absolute pixel floor.
 *   - Calls onResize callback on every move to let the parent refit xterm.
 *   - On drag end, computes the ratio from final pixel / available dimension
 *     and persists it to settingsStore — for every end except unmount, where
 *     the panel that was being measured is going away.
 *   - `toggleMaximize` (F6) snaps the panel to the cap and back to the
 *     STORED ratio, without rewriting that ratio.
 *   - The cap was 50%, on the reasoning that a bigger panel is a temporary
 *     need the maximize toggle covers. That reasoning did not survive contact:
 *     the toggle snaps to the SAME constant, so "temporarily bigger" also
 *     stopped at 50% and the escape hatch it justified never existed. Raised
 *     to 80% in #1279, matching the range `clamp.ts` had been persisting all
 *     along. The editor stays usable via TERMINAL_MIN_HEIGHT/WIDTH, which are
 *     absolute pixel floors and bind first on a small window.
 *
 * @coordinates-with TerminalPanel.tsx — attaches handleResizeStart to the resize handle
 * @coordinates-with uiStore — updates terminalHeight / terminalWidth during drag
 * @coordinates-with settingsStore — persists panelRatio on drag end
 * @coordinates-with useTerminalPosition.ts — pixelsToRatio / getAvailableDimension helpers
 * @coordinates-with hooks/useDocumentDrag.ts — document listener lifetime
 * @module components/Terminal/useTerminalResize
 */
import { useCallback } from "react";
import { useUIStore, TERMINAL_MAX_RATIO, type EffectiveTerminalPosition } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useDocumentDrag } from "@/hooks/useDocumentDrag";
import {
  pixelsToRatio,
  getAvailableDimension,
  isHorizontalTerminalAxis,
  currentShellSideWidth,
} from "./useTerminalPosition";

/**
 * Hook providing drag-to-resize behavior for the terminal panel edge.
 *
 * The handle sits on the edge adjacent to the editor, so the drag direction
 * that *grows* the panel depends on which side the panel is on:
 *   - right / bottom: handle on the near (left/top) edge → drag toward the
 *     editor (left/up) grows it (negative client delta = larger).
 *   - left / top: handle on the far (right/bottom) edge → drag away from the
 *     editor (right/down) grows it (positive client delta = larger).
 */
export interface TerminalResizeControls {
  /** mousedown handler for the drag handle. */
  handleResizeStart: (e: React.MouseEvent) => void;
  /** Snap to the cap, or back to the persisted ratio if already maximized. */
  toggleMaximize: () => void;
}

export function useTerminalResize(
  position: EffectiveTerminalPosition,
  onResize?: () => void
): TerminalResizeControls {
  const horizontal = isHorizontalTerminalAxis(position);
  // right/bottom grow on negative client delta; left/top grow on positive.
  const growSign = position === "right" || position === "bottom" ? -1 : 1;
  const drag = useDocumentDrag();

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      // Per-press state lives in this closure, so a drag that is still
      // attached when the next press arrives keeps its own numbers.
      const ui = useUIStore.getState();
      const startPos = horizontal ? e.clientX : e.clientY;
      const startSize = horizontal ? ui.terminalWidth : ui.terminalHeight;
      // Whether the pointer actually moved during this press. A double-click
      // delivers two full mousedown/mouseup pairs, and persisting on every
      // mouseup would write the CURRENT size back as the stored ratio — so the
      // second double-click would save the maximized size and "restore" would
      // become a no-op. Only a real drag may change the persisted size.
      let didDrag = false;

      const handleMouseMove = (e: MouseEvent) => {
        const ui = useUIStore.getState();
        // Cap live drag at 80% of available space (TERMINAL_MAX_RATIO); the
        // store setters only enforce the pixel floor.
        const available = getAvailableDimension(
          ui.effectiveTerminalPosition,
          window.innerWidth,
          window.innerHeight,
          currentShellSideWidth(),
        );
        const maxPixels = available * TERMINAL_MAX_RATIO;

        // growSign flips drag direction for left/top vs right/bottom panels.
        const pointer = horizontal ? e.clientX : e.clientY;
        const delta = (pointer - startPos) * growSign;
        if (delta !== 0) didDrag = true;
        const size = Math.min(maxPixels, startSize + delta);
        if (horizontal) ui.setTerminalWidth(size);
        else ui.setTerminalHeight(size);
        onResize?.();
      };

      const persistRatio = () => {
        const ui = useUIStore.getState();
        const pos = ui.effectiveTerminalPosition;
        const pixels = isHorizontalTerminalAxis(pos) ? ui.terminalWidth : ui.terminalHeight;
        const available = getAvailableDimension(
          pos,
          window.innerWidth,
          window.innerHeight,
          currentShellSideWidth(),
        );
        const ratio = pixelsToRatio(pixels, available);
        useSettingsStore.getState().updateTerminalSetting("panelRatio", ratio);
      };

      drag.start({
        cursor: horizontal ? "col-resize" : "row-resize",
        onMove: handleMouseMove,
        onEnd: (reason) => {
          // A press with no movement is a click, not a resize — persisting
          // there would overwrite the user's stored ratio with whatever the
          // panel happens to measure right now (see `didDrag`).
          if (didDrag && reason !== "unmount") persistRatio();
        },
      });
    },
    [drag, horizontal, growSign, onResize]
  );

  /**
   * Toggle between the persisted ratio and the cap. Deliberately does
   * NOT write `panelRatio`: restoring must land on whatever the user chose,
   * and a maximize should not silently become their new default.
   */
  const toggleMaximize = useCallback(() => {
    const ui = useUIStore.getState();
    const pos = ui.effectiveTerminalPosition;
    const horizontalAxis = isHorizontalTerminalAxis(pos);
    const available = getAvailableDimension(
      pos,
      window.innerWidth,
      window.innerHeight,
      currentShellSideWidth(),
    );
    if (available <= 0) return;

    const maxPixels = Math.round(available * TERMINAL_MAX_RATIO);
    const current = horizontalAxis ? ui.terminalWidth : ui.terminalHeight;
    const storedRatio = useSettingsStore.getState().terminal.panelRatio;
    // Within a pixel of the cap counts as maximized — rounding must not make
    // the toggle a one-way trip.
    const maximized = Math.abs(current - maxPixels) <= 1;
    const target = maximized
      ? Math.round(available * Math.min(storedRatio, TERMINAL_MAX_RATIO))
      : maxPixels;

    if (horizontalAxis) ui.setTerminalWidth(target);
    else ui.setTerminalHeight(target);
    // Deliberately NOT calling onResize: the store write above already drives
    // TerminalPanel's width/height effect, which refits. Calling it too would
    // schedule the same fit twice for one toggle.
  }, []);

  return { handleResizeStart, toggleMaximize };
}
