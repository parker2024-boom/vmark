/**
 * useMenuPosition
 *
 * Purpose: place a fixed-position popup menu at viewport coordinates and KEEP
 * it on screen — shared by every React context menu, so the placement rules
 * (and their edge cases) exist once.
 *
 * Key decisions:
 *   - Positioning is imperative (writes style.left/top on the element) rather
 *     than state-driven: the correction needs the menu's measured size, so a
 *     state round-trip would paint the unclamped position first. It runs in a
 *     layout effect for the same reason — before paint, no flicker.
 *   - The arithmetic is `clampMenuPosition`; this hook only measures and
 *     applies. A menu larger than the window lands on the near margin, never
 *     at a negative coordinate.
 *   - Both inputs of the clamp are observed after the first placement: the
 *     viewport (window resize/scroll, visualViewport resize/scroll) and the
 *     menu's own box (`ResizeObserver` — translated labels and late fonts
 *     resize a menu after its anchor was chosen).
 *   - A menu that renders nothing while closed passes `open: false` (or a null
 *     position); re-opening at the same coordinates still re-places it,
 *     because `open` is an effect dependency.
 *
 * @coordinates-with utils/menuPosition.ts — the pure clamp
 * @module hooks/useMenuPosition
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  MENU_VIEWPORT_MARGIN,
  clampMenuPosition,
  viewportMenuBounds,
  type MenuPoint,
} from "@/utils/menuPosition";

export type { MenuPoint } from "@/utils/menuPosition";

interface MenuPositionOptions {
  /** False while the menu is not rendered. Defaults to true. */
  open?: boolean;
  /** Gap kept to the viewport edge. Defaults to MENU_VIEWPORT_MARGIN. */
  margin?: number;
}

/** Keep `menuRef`'s element pinned at `position`, clamped into the viewport. */
export function useMenuPosition(
  menuRef: RefObject<HTMLElement | null>,
  position: MenuPoint | null,
  { open = true, margin = MENU_VIEWPORT_MARGIN }: MenuPositionOptions = {},
): void {
  const positionRef = useRef(position);

  const applyMenuPosition = useCallback(() => {
    const menu = menuRef.current;
    const at = positionRef.current;
    if (!menu || !at) return;

    const { width, height } = menu.getBoundingClientRect();
    const clamped = clampMenuPosition(
      at,
      { width, height },
      viewportMenuBounds({ width: window.innerWidth, height: window.innerHeight }, margin),
    );

    menu.style.left = `${clamped.x}px`;
    menu.style.top = `${clamped.y}px`;
  }, [menuRef, margin]);

  useLayoutEffect(() => {
    positionRef.current = position;
    if (open) applyMenuPosition();
  }, [applyMenuPosition, position, open]);

  useEffect(() => {
    if (!open) return;
    const handleViewportChange = () => applyMenuPosition();
    const visualViewport = window.visualViewport;

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    visualViewport?.addEventListener("resize", handleViewportChange);
    visualViewport?.addEventListener("scroll", handleViewportChange);
    const menu = menuRef.current;
    const observer =
      menu && typeof ResizeObserver === "function" ? new ResizeObserver(handleViewportChange) : null;
    if (menu) observer?.observe(menu);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      visualViewport?.removeEventListener("resize", handleViewportChange);
      visualViewport?.removeEventListener("scroll", handleViewportChange);
      observer?.disconnect();
    };
  }, [applyMenuPosition, menuRef, open]);
}
