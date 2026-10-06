// @vitest-environment node
// WI-RA9B.4 — the one menu clamp: never negative, never NaN, and a menu that
// cannot fit lands on the near margin instead of off screen.
// WI-RA18.6 — bounds narrowed to a menu's container, for menus drawn inside one.
import { describe, expect, it } from "vitest";
import {
  MENU_VIEWPORT_MARGIN,
  clampMenuPosition,
  menuBoundsWithin,
  viewportMenuBounds,
  type MenuBounds,
  type MenuPoint,
  type MenuSize,
} from "./menuPosition";

const VIEWPORT = { width: 1000, height: 800 };
const BOUNDS = viewportMenuBounds(VIEWPORT);
const MENU = { width: 200, height: 120 };

describe("viewportMenuBounds", () => {
  it("insets the viewport by the default margin on every side", () => {
    expect(BOUNDS).toEqual({ left: 10, top: 10, right: 990, bottom: 790 });
    expect(MENU_VIEWPORT_MARGIN).toBe(10);
  });

  it("honours a caller-supplied margin", () => {
    expect(viewportMenuBounds(VIEWPORT, 8)).toEqual({ left: 8, top: 8, right: 992, bottom: 792 });
  });
});

describe("menuBoundsWithin", () => {
  it("insets the container by the margin where it is inside the bounds", () => {
    expect(menuBoundsWithin(BOUNDS, { left: 100, top: 50, right: 600, bottom: 400 })).toEqual({
      left: 110, top: 60, right: 590, bottom: 390,
    });
  });

  it("keeps the outer bounds where the container reaches past them", () => {
    expect(menuBoundsWithin(BOUNDS, { left: -300, top: -50, right: 1400, bottom: 2000 })).toEqual(BOUNDS);
  });

  it("honours a caller-supplied margin", () => {
    expect(menuBoundsWithin(BOUNDS, { left: 100, top: 50, right: 600, bottom: 400 }, 4)).toEqual({
      left: 104, top: 54, right: 596, bottom: 396,
    });
  });

  it("feeds the clamp: a menu wider than its container lands on the container's near margin", () => {
    const within = menuBoundsWithin(BOUNDS, { left: 100, top: 50, right: 300, bottom: 400 });
    expect(clampMenuPosition({ x: 250, y: 60 }, MENU, within)).toEqual({ x: 110, y: 60 });
  });
});

describe("clampMenuPosition", () => {
  const cases: Array<{
    name: string;
    at: MenuPoint;
    size: MenuSize;
    bounds: MenuBounds;
    want: MenuPoint;
  }> = [
    { name: "a menu that fits stays at the pointer", at: { x: 300, y: 400 }, size: MENU, bounds: BOUNDS, want: { x: 300, y: 400 } },
    { name: "right overflow is pulled back inside", at: { x: 990, y: 100 }, size: MENU, bounds: BOUNDS, want: { x: 790, y: 100 } },
    { name: "bottom overflow is pulled back inside", at: { x: 100, y: 795 }, size: MENU, bounds: BOUNDS, want: { x: 100, y: 670 } },
    { name: "both axes overflow at once", at: { x: 999, y: 799 }, size: MENU, bounds: BOUNDS, want: { x: 790, y: 670 } },
    { name: "a menu exactly filling the bounds is not moved", at: { x: 10, y: 10 }, size: { width: 980, height: 780 }, bounds: BOUNDS, want: { x: 10, y: 10 } },
    { name: "a pointer above/left of the margin snaps to the margin", at: { x: -50, y: 0 }, size: MENU, bounds: BOUNDS, want: { x: 10, y: 10 } },
    { name: "a menu wider and taller than the viewport sits on the near margin", at: { x: 400, y: 400 }, size: { width: 2000, height: 2000 }, bounds: BOUNDS, want: { x: 10, y: 10 } },
    { name: "a tiny window (smaller than the menu) never yields a negative coordinate", at: { x: 60, y: 60 }, size: MENU, bounds: viewportMenuBounds({ width: 100, height: 80 }), want: { x: 10, y: 10 } },
    { name: "a zero-sized window", at: { x: 5, y: 5 }, size: MENU, bounds: viewportMenuBounds({ width: 0, height: 0 }), want: { x: 10, y: 10 } },
    { name: "a window narrower than twice the margin", at: { x: 3, y: 3 }, size: { width: 4, height: 4 }, bounds: viewportMenuBounds({ width: 12, height: 12 }), want: { x: 10, y: 10 } },
    { name: "an unmeasured (zero-size) menu only needs the margin", at: { x: 995, y: 795 }, size: { width: 0, height: 0 }, bounds: BOUNDS, want: { x: 990, y: 790 } },
    { name: "fractional sizes are not rounded", at: { x: 900, y: 100 }, size: { width: 150.5, height: 20 }, bounds: BOUNDS, want: { x: 839.5, y: 100 } },
    { name: "a lower bottom bound (an editor pane) wins over the viewport", at: { x: 100, y: 350 }, size: { width: 100, height: 150 }, bounds: { ...BOUNDS, bottom: 384 }, want: { x: 100, y: 234 } },
    { name: "a bottom bound above the top bound still keeps the menu on screen", at: { x: 100, y: 350 }, size: { width: 100, height: 150 }, bounds: { ...BOUNDS, bottom: -40 }, want: { x: 100, y: 10 } },
    { name: "negative near bounds are floored at zero", at: { x: -500, y: -500 }, size: MENU, bounds: { left: -30, top: -30, right: 990, bottom: 790 }, want: { x: 0, y: 0 } },
    { name: "a NaN pointer falls back to the near margin", at: { x: Number.NaN, y: Number.NaN }, size: MENU, bounds: BOUNDS, want: { x: 10, y: 10 } },
    { name: "an infinite pointer is clamped to the nearest bound", at: { x: Infinity, y: -Infinity }, size: MENU, bounds: BOUNDS, want: { x: 790, y: 10 } },
    { name: "a NaN menu size is treated as unmeasured", at: { x: 995, y: 100 }, size: { width: Number.NaN, height: Number.NaN }, bounds: BOUNDS, want: { x: 990, y: 100 } },
  ];

  it.each(cases)("$name", ({ at, size, bounds, want }) => {
    expect(clampMenuPosition(at, size, bounds)).toEqual(want);
  });

  it("is never negative and never non-finite across a sweep of hostile inputs", () => {
    const numbers = [-1e9, -1, 0, 0.5, 7, 100, 5000, 1e9, Number.NaN, Infinity, -Infinity];
    for (const x of numbers) {
      for (const w of numbers) {
        for (const vw of numbers) {
          for (const margin of [10, 0, -5, Number.NaN]) {
            const got = clampMenuPosition(
              { x, y: x },
              { width: w, height: w },
              viewportMenuBounds({ width: vw, height: vw }, margin),
            );
            expect(got.x).toBeGreaterThanOrEqual(0);
            expect(got.y).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(got.x) && Number.isFinite(got.y)).toBe(true);
          }
        }
      }
    }
  });

  it("is idempotent — clamping a clamped point changes nothing", () => {
    const once = clampMenuPosition({ x: 2000, y: -3 }, MENU, BOUNDS);
    expect(clampMenuPosition(once, MENU, BOUNDS)).toEqual(once);
  });

  it("tracks a shrinking viewport, which is what a window resize is", () => {
    const at = { x: 900, y: 700 };
    expect(clampMenuPosition(at, MENU, viewportMenuBounds(VIEWPORT, 8))).toEqual({ x: 792, y: 672 });
    expect(clampMenuPosition(at, MENU, viewportMenuBounds({ width: 500, height: 400 }, 8))).toEqual({ x: 292, y: 272 });
  });
});
