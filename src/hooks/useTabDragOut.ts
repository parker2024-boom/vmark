/**
 * Tab Drag-Out Hook
 *
 * Purpose: Manages tab drag interactions — reorder within the tab bar or drag out to detach into a new window.
 *
 * Key decisions:
 *   - Uses pointer events (not mouse) for touch support
 *   - DRAG_OUT_THRESHOLD (40px vertical) distinguishes reorder from detach
 *   - REORDER_LOCK_THRESHOLD (6px horizontal) prevents accidental reorder on click
 *   - Auto-scroll at tab bar edges during reorder
 *   - Touch hold delay (180ms) before entering drag mode on mobile
 *   - The document listeners belong to `useDocumentDrag`, so a drag also ends
 *     when the window loses focus, when the tab bar unmounts, and when a new
 *     press arrives with the old drag still attached. Every end releases the
 *     pointer capture and clears the hold timer; only a release commits.
 *
 * @coordinates-with tabStore.ts — reorder and detach mutations
 * @coordinates-with hooks/useDocumentDrag.ts — document listener lifetime
 * @coordinates-with utils/tabDragGeometry.ts — drop index, detach band, auto-scroll
 * @module hooks/useTabDragOut
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useDocumentDrag } from "@/hooks/useDocumentDrag";
import {
  calcAutoScrollDelta,
  calcDropIndex,
  isOutsideVerticalBand,
  toPoint,
  type DragOutPoint,
} from "@/utils/tabDragGeometry";

export type { DragOutPoint } from "@/utils/tabDragGeometry";

/** Horizontal distance (px) to lock into reorder mode. */
const REORDER_LOCK_THRESHOLD = 6;
const TOUCH_HOLD_DELAY_MS = 180;
const TOUCH_HOLD_CANCEL_PX = 8;

/** Current phase of a tab drag interaction. */
type DragMode = "idle" | "hold" | "pending" | "reorder" | "dragout";

/** Payload emitted on each pointer move during a tab drag. */
interface DragMovePayload {
  tabId: string;
  mode: Exclude<DragMode, "idle" | "hold">;
  point: DragOutPoint;
  dropIndex: number | null;
}

interface UseTabDragOptions {
  tabBarRef: RefObject<HTMLElement | null>;
  onDragOut: (tabId: string, point: DragOutPoint) => void | Promise<void>;
  onReorder: (tabId: string, toIndex: number) => void;
  onDragMove?: (payload: DragMovePayload) => void;
}

interface TabDragHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
}

interface UseTabDragResult {
  getTabDragHandlers: (tabId: string, isPinned: boolean) => TabDragHandlers;
  isDragging: boolean;
  isReordering: boolean;
  dragMode: DragMode;
  dragTabId: string | null;
  dropIndex: number | null;
  dragPoint: DragOutPoint | null;
}

/** Hook that manages tab drag interactions -- reorder within the bar or drag out to detach. */
export function useTabDragOut({ tabBarRef, onDragOut, onReorder, onDragMove }: UseTabDragOptions): UseTabDragResult {
  const [isDragging, setIsDragging] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [dragMode, setDragMode] = useState<DragMode>("idle");
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragPoint, setDragPoint] = useState<DragOutPoint | null>(null);

  // Track drop index in a ref so the drag's end can read it synchronously
  const dropIndexRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const dragPointRef = useRef<DragOutPoint | null>(null);

  const stateRef = useRef({
    tabId: null as string | null,
    mode: "idle" as DragMode,
    startX: 0,
    startY: 0,
    holdTimer: null as ReturnType<typeof setTimeout> | null,
    isHoldingPointer: false,
  });

  const emitDragPoint = useCallback((point: DragOutPoint) => {
    dragPointRef.current = point;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setDragPoint(dragPointRef.current);
    });
  }, []);

  const setMode = useCallback((mode: DragMode) => {
    /* v8 ignore next -- @preserve false branch unreachable: setMode is only called at state transitions, never with the current mode */
    if (stateRef.current.mode !== mode) {
      stateRef.current.mode = mode;
      setDragMode(mode);
    }
  }, []);

  // Latest-value refs read by synchronous document pointer listeners during a drag, so they must be render-synced (fresh before a pointer event fires), not passive (#1063).
  const onDragOutRef = useRef(onDragOut);
  const onReorderRef = useRef(onReorder);
  const onDragMoveRef = useRef(onDragMove);
  const stableBarRef = useRef(tabBarRef);
  /* eslint-disable react-hooks/refs -- latest-value refs read by document pointer listeners mid-drag must be fresh before any event fires */
  onDragOutRef.current = onDragOut;
  onReorderRef.current = onReorder;
  onDragMoveRef.current = onDragMove;
  stableBarRef.current = tabBarRef;
  /* eslint-enable react-hooks/refs */

  const drag = useDocumentDrag("pointer");

  /** Return every piece of per-drag state to idle. Runs when a drag ends, however it ends. */
  const resetDrag = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (stateRef.current.holdTimer) {
      clearTimeout(stateRef.current.holdTimer);
    }
    stateRef.current = {
      tabId: null,
      mode: "idle",
      startX: 0,
      startY: 0,
      holdTimer: null,
      isHoldingPointer: false,
    };
    dropIndexRef.current = null;
    setIsDragging(false);
    setIsReordering(false);
    setDragMode("idle");
    setDragTabId(null);
    setDropIndex(null);
    setDragPoint(null);
  }, []);

  const getTabDragHandlers = useCallback(
    (tabId: string, isPinned: boolean): TabDragHandlers => ({
      onPointerDown: (e: ReactPointerEvent) => {
        // Only primary button; skip pinned tabs
        if (e.button !== 0 || isPinned) return;

        // Skip drag init on the close button — pointer capture would steal the
        // pointerup, making the tab un-closable via X.
        const target = e.target;
        if (target instanceof Element && target.closest("[data-tab-close]")) return;

        // A press can arrive while a previous drag is still attached (its
        // pointerup was delivered outside the window). End it before this
        // press writes the per-drag state it would otherwise reset.
        drag.stop();

        const captureTarget = e.currentTarget as HTMLElement;
        const pointerId = e.pointerId;
        try {
          captureTarget.setPointerCapture(pointerId);
        } catch {
          // Best effort: some environments may reject pointer capture.
        }

        const isTouchLike = e.pointerType === "touch" || e.pointerType === "pen";
        stateRef.current = {
          tabId,
          mode: isTouchLike ? "hold" : "pending",
          startX: e.clientX,
          startY: e.clientY,
          holdTimer: null,
          isHoldingPointer: isTouchLike,
        };
        dropIndexRef.current = null;
        if (!isTouchLike) {
          setDragTabId(tabId);
          setDragMode("pending");
        } else {
          setDragMode("hold");
          stateRef.current.holdTimer = setTimeout(() => {
            const s = stateRef.current;
            /* v8 ignore next -- @preserve guard unreachable: resetDrag() clears holdTimer before changing tabId/mode */
            if (s.tabId !== tabId || s.mode !== "hold") return;
            s.isHoldingPointer = false;
            setMode("pending");
            setDragTabId(tabId);
          }, TOUCH_HOLD_DELAY_MS);
        }

        const handleMove = (ev: PointerEvent) => {
          const s = stateRef.current;
          /* v8 ignore next -- @preserve guard unreachable: the drag session removes this listener before resetDrag() nulls tabId */
          if (!s.tabId) return;

          const point = toPoint(ev);
          emitDragPoint(point);

          if (s.mode === "hold") {
            const holdDx = Math.abs(ev.clientX - s.startX);
            const holdDy = Math.abs(ev.clientY - s.startY);
            if (holdDx > TOUCH_HOLD_CANCEL_PX || holdDy > TOUCH_HOLD_CANCEL_PX) {
              drag.stop();
            }
            return;
          }

          const bar = stableBarRef.current.current;
          if (!bar) return;

          const dx = ev.clientX - s.startX;
          const barRect = bar.getBoundingClientRect();
          const barTop = barRect.top;
          const barBottom = barRect.bottom;

          if (s.mode === "pending") {
            // Direction lock: determine reorder vs drag-out
            if (isOutsideVerticalBand(barTop, barBottom, ev.clientY)) {
              setMode("dragout");
              setIsDragging(true);
            } else if (Math.abs(dx) > REORDER_LOCK_THRESHOLD) {
              const idx = calcDropIndex(bar, ev.clientX);
              if (idx < 0) return; // DOM not ready — stay pending
              setMode("reorder");
              setIsReordering(true);
              dropIndexRef.current = idx;
              setDropIndex(idx);
            }
          } else if (s.mode === "reorder") {
            const tablist = bar.querySelector<HTMLElement>("[role='tablist']");
            if (tablist) {
              const delta = calcAutoScrollDelta(tablist.getBoundingClientRect(), ev.clientX);
              if (delta !== 0) {
                tablist.scrollLeft += delta;
              }
            }
            // Update drop position
            const idx = calcDropIndex(bar, ev.clientX);
            if (idx < 0) return; // DOM disappeared mid-drag — keep last position
            if (dropIndexRef.current !== idx) {
              dropIndexRef.current = idx;
              setDropIndex(idx);
            }

            // Allow escape to drag-out even while reordering
            if (isOutsideVerticalBand(barTop, barBottom, ev.clientY)) {
              setMode("dragout");
              setIsReordering(false);
              setIsDragging(true);
              dropIndexRef.current = null;
              setDropIndex(null);
            }
          }

          const mode = stateRef.current.mode;
          /* v8 ignore next -- @preserve false branch unreachable: "hold" returns early on line 247, so mode is always reorder/dragout/pending here */
          if (mode === "reorder" || mode === "dragout" || mode === "pending") {
            onDragMoveRef.current?.({
              tabId,
              mode,
              point,
              dropIndex: dropIndexRef.current,
            });
          }
        };

        drag.start({
          onMove: handleMove,
          onEnd: (reason, ev) => {
            const s = stateRef.current;
            // Only a release commits; a cancel, a blur, an unmount or a new
            // press abandons the drag where it was.
            if (reason === "release" && ev && s.tabId && s.mode !== "hold") {
              if (s.mode === "dragout") {
                void Promise.resolve(onDragOutRef.current(s.tabId, toPoint(ev)));
              } else if (s.mode === "reorder" && dropIndexRef.current !== null) {
                onReorderRef.current(s.tabId, dropIndexRef.current);
              }
            }
            try {
              if (captureTarget.hasPointerCapture(pointerId)) {
                captureTarget.releasePointerCapture(pointerId);
              }
            } catch {
              // Best effort cleanup.
            }
            resetDrag();
          },
        });
      },
    }),
    [drag, resetDrag, emitDragPoint, setMode]
  );

  return { getTabDragHandlers, isDragging, isReordering, dragMode, dragTabId, dropIndex, dragPoint };
}
