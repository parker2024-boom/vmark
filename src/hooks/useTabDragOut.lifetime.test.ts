// WI-RA9B.11 — a tab drag's document listeners, pointer capture and hold timer
// must not outlive the drag: not past unmount, not past a second press, not
// past the window losing focus.
import { createRef, type PointerEvent as ReactPointerEvent } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabDragOut } from "./useTabDragOut";

function rectOf(top: number, left: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, top, left, width, height,
    right: left + width, bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A 40px-tall bar at the top of the viewport holding two 100px tabs. */
function createTabBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.getBoundingClientRect = () => rectOf(0, 0, 1000, 40);
  const tablist = document.createElement("div");
  tablist.setAttribute("role", "tablist");
  tablist.getBoundingClientRect = () => rectOf(0, 0, 300, 40);
  [0, 100].forEach((left) => {
    const tab = document.createElement("div");
    tab.setAttribute("role", "tab");
    tab.getBoundingClientRect = () => rectOf(0, left, 100, 40);
    tablist.appendChild(tab);
  });
  bar.appendChild(tablist);
  document.body.appendChild(bar);
  return bar;
}

function dispatchPointer(type: string, clientX: number, clientY: number): void {
  document.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX, clientY, screenX: clientX, screenY: clientY }),
  );
}

function pointerDown(
  clientX: number,
  clientY: number,
  pointerType: "mouse" | "touch" = "mouse",
) {
  const captureTarget = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  };
  const event = {
    button: 0,
    clientX,
    clientY,
    pointerId: 7,
    pointerType,
    target: document.createElement("div"),
    currentTarget: captureTarget,
  } as unknown as ReactPointerEvent;
  return { event, captureTarget };
}

function setup() {
  const tabBarRef = createRef<HTMLElement>();
  tabBarRef.current = createTabBar();
  const onDragOut = vi.fn();
  const onReorder = vi.fn();
  const onDragMove = vi.fn();
  const hook = renderHook(() => useTabDragOut({ tabBarRef, onDragOut, onReorder, onDragMove }));
  return { ...hook, onDragOut, onReorder, onDragMove };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useTabDragOut — listener lifetime", () => {
  it("unmount mid-drag removes the document listeners and releases the pointer", () => {
    const { result, unmount, onDragOut, onReorder, onDragMove } = setup();
    const { event, captureTarget } = pointerDown(10, 20);

    act(() => {
      result.current.getTabDragHandlers("tab-1", false).onPointerDown(event);
      dispatchPointer("pointermove", 220, 20);
    });
    expect(result.current.isReordering).toBe(true);
    const movesBeforeUnmount = onDragMove.mock.calls.length;
    expect(movesBeforeUnmount).toBeGreaterThan(0);

    unmount();

    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
    dispatchPointer("pointermove", 230, 200);
    dispatchPointer("pointerup", 230, 200);
    expect(onDragMove).toHaveBeenCalledTimes(movesBeforeUnmount);
    expect(onReorder).not.toHaveBeenCalled();
    expect(onDragOut).not.toHaveBeenCalled();
  });

  it("unmount during a touch hold cancels the hold timer", () => {
    vi.useFakeTimers();
    const { result, unmount, onDragMove } = setup();
    const { event } = pointerDown(10, 20, "touch");

    act(() => {
      result.current.getTabDragHandlers("tab-1", false).onPointerDown(event);
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    dispatchPointer("pointermove", 12, 22);
    expect(onDragMove).not.toHaveBeenCalled();
  });

  it("a second press before the first release does not leak the first drag", () => {
    // A pointerup delivered outside the window never reaches the document, so
    // the next press arrives with the previous drag still attached.
    const { result, onDragMove, onReorder } = setup();
    const first = pointerDown(10, 20);
    const second = pointerDown(10, 20);

    act(() => {
      result.current.getTabDragHandlers("tab-1", false).onPointerDown(first.event);
      result.current.getTabDragHandlers("tab-2", false).onPointerDown(second.event);
    });
    expect(first.captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);

    act(() => {
      dispatchPointer("pointermove", 220, 20);
    });
    // One report per move, and for the tab being dragged now.
    expect(onDragMove).toHaveBeenCalledTimes(1);
    expect(onDragMove.mock.calls[0][0].tabId).toBe("tab-2");

    act(() => {
      dispatchPointer("pointerup", 220, 20);
    });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("tab-2", 2);
    expect(result.current.dragMode).toBe("idle");
    expect(result.current.dragTabId).toBeNull();
  });

  it("window blur mid-drag cancels it without reordering or detaching", () => {
    const { result, onDragOut, onReorder, onDragMove } = setup();
    const { event, captureTarget } = pointerDown(10, 20);

    act(() => {
      result.current.getTabDragHandlers("tab-1", false).onPointerDown(event);
      dispatchPointer("pointermove", 220, 20);
    });
    expect(result.current.isReordering).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(result.current.dragMode).toBe("idle");
    expect(result.current.isReordering).toBe(false);
    expect(result.current.dropIndex).toBeNull();
    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);

    const moves = onDragMove.mock.calls.length;
    act(() => {
      dispatchPointer("pointermove", 230, 200);
      dispatchPointer("pointerup", 230, 200);
    });
    expect(onDragMove).toHaveBeenCalledTimes(moves);
    expect(onReorder).not.toHaveBeenCalled();
    expect(onDragOut).not.toHaveBeenCalled();
  });

  it("pointercancel ends the drag without committing it", () => {
    const { result, onDragOut, onReorder } = setup();
    const { event } = pointerDown(10, 20);

    act(() => {
      result.current.getTabDragHandlers("tab-1", false).onPointerDown(event);
      dispatchPointer("pointermove", 220, 200);
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      dispatchPointer("pointercancel", 220, 200);
      dispatchPointer("pointerup", 220, 200);
    });

    expect(result.current.dragMode).toBe("idle");
    expect(onDragOut).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });
});
