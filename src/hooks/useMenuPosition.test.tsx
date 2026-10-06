// WI-RA9B.4 — the shared menu placement hook: clamps through the one pure
// function, re-places on reopen, and follows the viewport and the menu box.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { useMenuPosition, type MenuPoint } from "./useMenuPosition";

const MENU_WIDTH = 180;
const MENU_HEIGHT = 300;

function Menu({ position }: { position: MenuPoint }) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuPosition(ref, position);
  return <div ref={ref} data-testid="menu" />;
}

function renderMenu(position: MenuPoint) {
  const { getByTestId, rerender } = render(<Menu position={position} />);
  const menu = getByTestId("menu") as HTMLDivElement;
  return {
    menu,
    rerender: (next: MenuPoint) => rerender(<Menu position={next} />),
  };
}

beforeEach(() => {
  window.innerWidth = 1000;
  window.innerHeight = 800;
  // jsdom reports a zero-sized rect for every element; give the menu a real box
  // so the overflow branches are actually exercised.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMenuPosition", () => {
  it("places the menu at the requested coordinates when it fits", () => {
    const { menu } = renderMenu({ x: 120, y: 60 });

    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("60px");
  });

  it("pulls the menu back inside on right/bottom overflow", () => {
    const { menu } = renderMenu({ x: 990, y: 790 });

    // Flush against the far edges, minus the menu size and the 10px margin.
    expect(menu.style.left).toBe(`${1000 - MENU_WIDTH - 10}px`);
    expect(menu.style.top).toBe(`${800 - MENU_HEIGHT - 10}px`);
  });

  it("keeps the margin when the menu is larger than the viewport", () => {
    window.innerWidth = 100;
    window.innerHeight = 100;
    const { menu } = renderMenu({ x: 90, y: 90 });

    expect(menu.style.left).toBe("10px");
    expect(menu.style.top).toBe("10px");
  });

  it("re-applies the position when it changes", () => {
    const { menu, rerender } = renderMenu({ x: 10, y: 10 });

    rerender({ x: 300, y: 200 });

    expect(menu.style.left).toBe("300px");
    expect(menu.style.top).toBe("200px");
  });

  it("re-clamps on viewport resize", () => {
    const { menu } = renderMenu({ x: 700, y: 400 });
    expect(menu.style.left).toBe("700px");

    window.innerWidth = 500;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(menu.style.left).toBe(`${500 - MENU_WIDTH - 10}px`);
  });

  it("detaches its viewport listeners on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Menu position={{ x: 10, y: 10 }} />);

    unmount();

    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
  });

  it("never writes a negative coordinate on a window smaller than the menu", () => {
    window.innerWidth = 120;
    window.innerHeight = 90;
    const { menu } = renderMenu({ x: 60, y: 40 });

    expect(menu.style.left).toBe("10px");
    expect(menu.style.top).toBe("10px");
  });

  it("honours a caller-supplied margin", () => {
    function Rail() {
      const ref = useRef<HTMLDivElement>(null);
      useMenuPosition(ref, { x: 990, y: 790 }, { margin: 8 });
      return <div ref={ref} data-testid="rail-menu" />;
    }
    const { getByTestId } = render(<Rail />);

    expect(getByTestId("rail-menu").style.left).toBe(`${1000 - MENU_WIDTH - 8}px`);
    expect(getByTestId("rail-menu").style.top).toBe(`${800 - MENU_HEIGHT - 8}px`);
  });

  it("re-places a menu that reopens at the same position object", () => {
    const position = { x: 990, y: 790 };
    function Toggled({ open }: { open: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useMenuPosition(ref, position, { open });
      return open ? <div ref={ref} data-testid="menu" style={{ left: position.x, top: position.y }} /> : null;
    }
    const { getByTestId, rerender } = render(<Toggled open />);
    expect(getByTestId("menu").style.left).toBe(`${1000 - MENU_WIDTH - 10}px`);

    rerender(<Toggled open={false} />);
    rerender(<Toggled open />);

    // A fresh element starts at the raw inline position; the hook must clamp it again.
    expect(getByTestId("menu").style.left).toBe(`${1000 - MENU_WIDTH - 10}px`);
    expect(getByTestId("menu").style.top).toBe(`${800 - MENU_HEIGHT - 10}px`);
  });

  it("does nothing for a null position or a closed menu", () => {
    function Closed({ position, open }: { position: MenuPoint | null; open: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useMenuPosition(ref, position, { open });
      return <div ref={ref} data-testid="menu" />;
    }
    const add = vi.spyOn(window, "addEventListener");
    const { getByTestId, rerender } = render(<Closed position={null} open />);
    expect(getByTestId("menu").style.left).toBe("");

    rerender(<Closed position={{ x: 990, y: 790 }} open={false} />);
    expect(getByTestId("menu").style.left).toBe("");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(getByTestId("menu").style.left).toBe("");
    expect(add.mock.calls.filter(([type]) => type === "resize" || type === "scroll").length).toBe(2);
  });

  it("re-clamps when the menu's own box grows (late labels, fonts)", () => {
    const observed: Array<() => void> = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {}
        observe() {
          observed.push(this.callback);
        }
        disconnect = disconnect;
      },
    );
    try {
      const { getByTestId, unmount } = render(<Menu position={{ x: 700, y: 400 }} />);
      const menu = getByTestId("menu");
      expect(menu.style.left).toBe("700px");
      expect(observed).toHaveLength(1);

      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 600, height: MENU_HEIGHT, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
        toJSON: () => ({}),
      } as DOMRect);
      act(() => observed[0]());

      expect(menu.style.left).toBe(`${1000 - 600 - 10}px`);
      unmount();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
