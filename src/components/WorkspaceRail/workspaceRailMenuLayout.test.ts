// WI-RA9B.4 — the rail menu's clamp hook: it delivers the SHARED clamp (pinned
// in utils/menuPosition.test.ts) at the rail's own 8px margin, and keeps
// delivering it when the viewport changes under an open menu.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMenuViewportClamp } from "./workspaceRailMenuLayout";

const MARGIN = 8;

function menuOfSize(width: number, height: number): { current: HTMLElement } {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;
  return { current: el };
}

beforeEach(() => {
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMenuViewportClamp", () => {
  it("leaves a menu that fits where the pointer put it", () => {
    const ref = menuOfSize(200, 120);
    const at = { x: 300, y: 400 };
    const { result } = renderHook(() => useMenuViewportClamp(at, ref));
    expect(result.current).toEqual({ x: 300, y: 400 });
  });

  it("pulls a menu opened near the far edges back inside, at the rail's margin", () => {
    const ref = menuOfSize(200, 120);
    const at = { x: 990, y: 795 };
    const { result } = renderHook(() => useMenuViewportClamp(at, ref));
    expect(result.current).toEqual({ x: 1000 - 200 - MARGIN, y: 800 - 120 - MARGIN });
  });

  it("never returns a negative coordinate for a menu larger than the viewport", () => {
    // A far-side clamp alone would place a too-tall menu at a negative y —
    // further off screen than the raw pointer position, and unreachable.
    window.innerWidth = 120;
    window.innerHeight = 90;
    const ref = menuOfSize(2000, 2000);
    const at = { x: 60, y: 40 };
    const { result } = renderHook(() => useMenuViewportClamp(at, ref));
    expect(result.current).toEqual({ x: MARGIN, y: MARGIN });
  });

  it("re-clamps when the window shrinks under an open menu", () => {
    const ref = menuOfSize(200, 120);
    const at = { x: 700, y: 600 };
    const { result } = renderHook(() => useMenuViewportClamp(at, ref));
    expect(result.current).toEqual({ x: 700, y: 600 });

    window.innerWidth = 500;
    window.innerHeight = 400;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toEqual({ x: 500 - 200 - MARGIN, y: 400 - 120 - MARGIN });
  });

  it("stops listening for resizes on unmount", () => {
    const remove = vi.spyOn(globalThis, "removeEventListener");
    const ref = menuOfSize(200, 120);
    const at = { x: 10, y: 10 };
    const { unmount } = renderHook(() => useMenuViewportClamp(at, ref));
    unmount();
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});
