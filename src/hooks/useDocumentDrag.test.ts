// WI-RA9B.5 — the shared document-drag session: listeners never stack, never
// outlive the drag, and `onEnd` runs exactly once with the reason.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDocumentDrag, type DocumentDragEndReason } from "./useDocumentDrag";

/** Every listener currently attached to document/window by type, via spies. */
function trackListeners() {
  const live = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = (type: string, fn: EventListenerOrEventListenerObject) => {
    if (!live.has(type)) live.set(type, new Set());
    live.get(type)?.add(fn);
  };
  const remove = (type: string, fn: EventListenerOrEventListenerObject) => {
    live.get(type)?.delete(fn);
  };
  const docAdd = document.addEventListener.bind(document);
  const docRemove = document.removeEventListener.bind(document);
  const winAdd = window.addEventListener.bind(window);
  const winRemove = window.removeEventListener.bind(window);
  vi.spyOn(document, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    add(`document:${type}`, fn);
    docAdd(type, fn, opts as AddEventListenerOptions);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    remove(`document:${type}`, fn);
    docRemove(type, fn, opts as EventListenerOptions);
  });
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    add(`window:${type}`, fn);
    winAdd(type, fn, opts as AddEventListenerOptions);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    remove(`window:${type}`, fn);
    winRemove(type, fn, opts as EventListenerOptions);
  });
  const DRAG_TYPES = [
    "document:mousemove", "document:mouseup",
    "document:pointermove", "document:pointerup", "document:pointercancel",
    "window:blur",
  ];
  return {
    count: () => DRAG_TYPES.reduce((n, type) => n + (live.get(type)?.size ?? 0), 0),
  };
}

function move(clientX: number, type = "mousemove"): void {
  document.dispatchEvent(new MouseEvent(type, { clientX }));
}

let listeners: ReturnType<typeof trackListeners>;

beforeEach(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  listeners = trackListeners();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDocumentDrag (mouse)", () => {
  it("delivers moves only between start and release", () => {
    const { result } = renderHook(() => useDocumentDrag());
    const onMove = vi.fn();
    const onEnd = vi.fn();

    move(1);
    result.current.start({ onMove, onEnd });
    expect(result.current.isActive()).toBe(true);
    move(10);
    move(20);
    const release = new MouseEvent("mouseup", { clientX: 20 });
    document.dispatchEvent(release);
    move(30);

    expect(onMove.mock.calls.map(([e]) => (e as MouseEvent).clientX)).toEqual([10, 20]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("release", release);
    expect(result.current.isActive()).toBe(false);
    expect(listeners.count()).toBe(0);
  });

  it.each<[string, DocumentDragEndReason, () => void]>([
    ["window blur", "blur", () => window.dispatchEvent(new Event("blur"))],
  ])("ends on %s with no event", (_name, reason, trigger) => {
    const { result } = renderHook(() => useDocumentDrag());
    const onMove = vi.fn();
    const onEnd = vi.fn();
    result.current.start({ onMove, onEnd });

    trigger();
    move(30);

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(reason, null);
    expect(onMove).not.toHaveBeenCalled();
    expect(listeners.count()).toBe(0);
  });

  it("stop() ends the drag as a cancel, and is a no-op when idle", () => {
    const { result } = renderHook(() => useDocumentDrag());
    const onEnd = vi.fn();

    result.current.stop();
    result.current.start({ onMove: vi.fn(), onEnd });
    result.current.stop();
    result.current.stop();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("cancel", null);
    expect(listeners.count()).toBe(0);
  });

  it("unmount mid-drag removes every listener and reports why", () => {
    const { result, unmount } = renderHook(() => useDocumentDrag());
    const onMove = vi.fn();
    const onEnd = vi.fn();
    result.current.start({ onMove, onEnd, cursor: "col-resize" });
    expect(listeners.count()).toBe(3);

    unmount();
    move(30);
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("unmount", null);
    expect(onMove).not.toHaveBeenCalled();
    expect(listeners.count()).toBe(0);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("a second start supersedes the first instead of stacking listeners", () => {
    const { result } = renderHook(() => useDocumentDrag());
    const first = { onMove: vi.fn(), onEnd: vi.fn() };
    const second = { onMove: vi.fn(), onEnd: vi.fn() };

    result.current.start(first);
    result.current.start(second);
    expect(listeners.count()).toBe(3);
    move(10);

    expect(first.onEnd).toHaveBeenCalledWith("superseded", null);
    expect(first.onMove).not.toHaveBeenCalled();
    expect(second.onMove).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(first.onEnd).toHaveBeenCalledTimes(1);
    expect(second.onEnd).toHaveBeenCalledTimes(1);
    expect(listeners.count()).toBe(0);
  });

  it("survives a hundred rapid restarts with one live session", () => {
    const { result } = renderHook(() => useDocumentDrag());
    const onMove = vi.fn();
    const onEnd = vi.fn();
    for (let i = 0; i < 100; i++) result.current.start({ onMove, onEnd });

    move(5);

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(99);
    expect(listeners.count()).toBe(3);
    result.current.stop();
    expect(listeners.count()).toBe(0);
  });

  it("sets the body cursor and user-select only when asked, and restores them", () => {
    const { result } = renderHook(() => useDocumentDrag());

    result.current.start({ onMove: vi.fn() });
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    result.current.stop();

    result.current.start({ onMove: vi.fn(), cursor: "row-resize" });
    expect(document.body.style.cursor).toBe("row-resize");
    expect(document.body.style.userSelect).toBe("none");
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("an idle hook's unmount leaves another resizer's body styles alone", () => {
    const { unmount } = renderHook(() => useDocumentDrag());
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    unmount();

    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
  });

  it("a cursor-less drag does not clear a cursor someone else set", () => {
    const { result } = renderHook(() => useDocumentDrag());
    document.body.style.cursor = "grabbing";

    result.current.start({ onMove: vi.fn() });
    result.current.stop();

    expect(document.body.style.cursor).toBe("grabbing");
  });

  it("onEnd may start the next drag without being torn down by the old one", () => {
    const { result } = renderHook(() => useDocumentDrag());
    const next = { onMove: vi.fn(), onEnd: vi.fn() };
    result.current.start({
      onMove: vi.fn(),
      onEnd: () => result.current.start(next),
    });

    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(result.current.isActive()).toBe(true);
    expect(listeners.count()).toBe(3);
    move(7);
    expect(next.onMove).toHaveBeenCalledTimes(1);
    expect(next.onEnd).not.toHaveBeenCalled();
    result.current.stop();
  });

  it("a throwing onEnd still leaves no listeners behind", () => {
    const { result } = renderHook(() => useDocumentDrag());
    result.current.start({
      onMove: vi.fn(),
      onEnd: () => {
        throw new Error("commit failed");
      },
      cursor: "col-resize",
    });

    expect(() => result.current.stop()).toThrow("commit failed");
    expect(result.current.isActive()).toBe(false);
    expect(listeners.count()).toBe(0);
    expect(document.body.style.cursor).toBe("");
  });

  it("returns the same controls object across renders", () => {
    const { result, rerender } = renderHook(() => useDocumentDrag());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("ignores pointer events", () => {
    const { result } = renderHook(() => useDocumentDrag());
    const onMove = vi.fn();
    const onEnd = vi.fn();
    result.current.start({ onMove, onEnd });

    move(10, "pointermove");
    document.dispatchEvent(new MouseEvent("pointerup"));
    document.dispatchEvent(new MouseEvent("pointercancel"));

    expect(onMove).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    result.current.stop();
  });
});

describe("useDocumentDrag (pointer)", () => {
  it("follows pointer events and ends on pointerup with the event", () => {
    const { result } = renderHook(() => useDocumentDrag("pointer"));
    const onMove = vi.fn();
    const onEnd = vi.fn();
    result.current.start({ onMove, onEnd });
    expect(listeners.count()).toBe(4);

    move(10, "pointermove");
    move(99, "mousemove");
    const up = new MouseEvent("pointerup", { clientX: 10 });
    document.dispatchEvent(up);
    move(20, "pointermove");

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("release", up);
    expect(listeners.count()).toBe(0);
  });

  it("ends on pointercancel as a cancel, carrying the event", () => {
    const { result } = renderHook(() => useDocumentDrag("pointer"));
    const onEnd = vi.fn();
    result.current.start({ onMove: vi.fn(), onEnd });

    const cancel = new MouseEvent("pointercancel");
    document.dispatchEvent(cancel);
    document.dispatchEvent(new MouseEvent("pointerup"));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("cancel", cancel);
    expect(listeners.count()).toBe(0);
  });

  it("ends on window blur and on unmount", () => {
    const { result, unmount } = renderHook(() => useDocumentDrag("pointer"));
    const onEnd = vi.fn();
    result.current.start({ onMove: vi.fn(), onEnd });
    window.dispatchEvent(new Event("blur"));
    expect(onEnd).toHaveBeenLastCalledWith("blur", null);

    result.current.start({ onMove: vi.fn(), onEnd });
    unmount();
    expect(onEnd).toHaveBeenLastCalledWith("unmount", null);
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(listeners.count()).toBe(0);
  });
});
