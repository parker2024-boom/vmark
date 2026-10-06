/**
 * Menu position clamp
 *
 * Purpose: the one place that decides where a pointer-anchored popup menu is
 * drawn so it stays on screen. Every context menu — React or imperative DOM —
 * goes through `clampMenuPosition`, so the edge cases are decided once.
 *
 * Key decisions:
 *   - Pure arithmetic, no DOM: callers measure, this decides. That keeps it
 *     importable from editor plugins and lets the edge cases be pinned in a
 *     table without a layout engine.
 *   - The near (left/top) bound is applied LAST. When the menu cannot fit, the
 *     far bound minus the menu size goes below the near bound — or below zero
 *     on a small window — and a far-side clamp alone would park the menu's
 *     first item off screen, out of reach. The near margin is the least-bad
 *     position: the top-left of the menu is always visible.
 *   - The result is never negative and never non-finite, whatever the inputs:
 *     an unmeasured menu, a zero-sized window during a transition, or a pointer
 *     event with non-finite coordinates must not produce a `left: NaNpx`.
 *   - Coordinates are physical left/top viewport pixels. Menus are anchored at
 *     the pointer and positioned with `left`/`top` in both writing directions,
 *     so the clamp has no direction-dependent branch.
 *
 * @coordinates-with hooks/useMenuPosition.ts — applies this to a React menu element
 * @coordinates-with plugins/tableUI/TiptapTableContextMenu.ts — an imperative caller
 * @coordinates-with plugins/codemirror/sourceTableContextMenu.ts — an imperative caller, inside its host
 * @module utils/menuPosition
 */

/** Smallest gap kept between a menu and the viewport edge. */
export const MENU_VIEWPORT_MARGIN = 10;

/** A point in viewport coordinates. */
export interface MenuPoint {
  x: number;
  y: number;
}

/** A measured box. */
export interface MenuSize {
  width: number;
  height: number;
}

/** The rectangle a menu must stay inside, in viewport coordinates. */
export interface MenuBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The viewport inset by `margin` on every side. */
export function viewportMenuBounds(
  viewport: MenuSize,
  margin: number = MENU_VIEWPORT_MARGIN,
): MenuBounds {
  return {
    left: margin,
    top: margin,
    right: viewport.width - margin,
    bottom: viewport.height - margin,
  };
}

/**
 * `bounds` narrowed to `container` inset by `margin` — for a menu drawn inside
 * a container (an editor's popup host) that may be offset, scrolled or partly
 * off screen. Where the container reaches past `bounds`, `bounds` wins.
 */
export function menuBoundsWithin(
  bounds: MenuBounds,
  container: MenuBounds,
  margin: number = MENU_VIEWPORT_MARGIN,
): MenuBounds {
  return {
    left: Math.max(bounds.left, container.left + margin),
    top: Math.max(bounds.top, container.top + margin),
    right: Math.min(bounds.right, container.right - margin),
    bottom: Math.min(bounds.bottom, container.bottom - margin),
  };
}

/** Clamp one axis: far bound first, near bound last, never negative or non-finite. */
function clampAxis(at: number, extent: number, near: number, far: number): number {
  const floor = Number.isFinite(near) ? Math.max(0, near) : 0;
  const size = Number.isFinite(extent) && extent > 0 ? extent : 0;
  const clamped = Math.max(floor, Math.min(at, far - size));
  // A NaN anywhere above poisons the min/max chain, and an unbounded far edge
  // lets an infinite pointer through; both resolve to the near edge.
  return Number.isFinite(clamped) ? clamped : floor;
}

/**
 * Where a `size`-sized menu requested at `at` should be drawn so it stays
 * inside `bounds`. A menu larger than the bounds lands on the near edge.
 */
export function clampMenuPosition(at: MenuPoint, size: MenuSize, bounds: MenuBounds): MenuPoint {
  return {
    x: clampAxis(at.x, size.width, bounds.left, bounds.right),
    y: clampAxis(at.y, size.height, bounds.top, bounds.bottom),
  };
}
