/**
 * Viewport clamping for the workspace rail's context menu.
 *
 * Purpose: keep an anchored menu fully on screen, and KEEP it there. The
 * component recomputed the clamp only when the anchor point changed,
 * so a window resize under an open menu, or a menu that grew after
 * its translated labels laid out, left it hanging off the bottom or right edge
 * with no way to reach the items. Both inputs — the viewport and the menu's own
 * box — are now observed.
 *
 * The arithmetic is the shared `clampMenuPosition`, so a menu taller than the
 * viewport clamps to the near margin rather than to a negative coordinate,
 * exactly as every other context menu does. What stays here is the rail's own
 * margin and its state-driven delivery: the component renders the clamped
 * point as a style prop.
 *
 * @coordinates-with ./WorkspaceRailContextMenu.tsx — the only consumer
 * @coordinates-with utils/menuPosition.ts — the pure clamp
 * @module components/WorkspaceRail/workspaceRailMenuLayout
 */
import { useLayoutEffect, useState, type RefObject } from "react";
import { clampMenuPosition, viewportMenuBounds, type MenuPoint } from "@/utils/menuPosition";

export type { MenuPoint } from "@/utils/menuPosition";

/** Keep the menu this far from the viewport edge when clamping. */
const VIEWPORT_MARGIN = 8;

/**
 * The clamped position for the menu in `ref`, recomputed whenever the anchor,
 * the viewport or the menu's own size changes.
 *
 * `ResizeObserver` covers the size half: the menu's labels are translated and
 * a font or a locale change resizes it after the anchor was chosen. Where the
 * engine has none, the anchor and viewport halves still work — this is a
 * placement refinement, not a correctness gate.
 */
export function useMenuViewportClamp(
  at: MenuPoint,
  ref: RefObject<HTMLElement | null>,
): MenuPoint {
  const [clamped, setClamped] = useState(at);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect();
      setClamped(
        clampMenuPosition(
          at,
          { width, height },
          viewportMenuBounds(
            { width: globalThis.innerWidth, height: globalThis.innerHeight },
            VIEWPORT_MARGIN,
          ),
        ),
      );
    };
    measure();

    globalThis.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => {
      globalThis.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [at, ref]);

  return clamped;
}
