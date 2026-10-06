// WI-RA18.9 — settings panels load per section: the cache remembers successes,
// shares in-flight imports, never replays a failure, and the hook reports
// `ready` only when every requested panel is loaded.
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { createPanelCache, usePanels } from "./panelCache";

type Id = "a" | "b" | "c";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PanelA: ComponentType = () => null;
const PanelB: ComponentType = () => null;
const PanelC: ComponentType = () => null;

function immediateLoaders() {
  return {
    a: vi.fn(() => Promise.resolve(PanelA)),
    b: vi.fn(() => Promise.resolve(PanelB)),
    c: vi.fn(() => Promise.resolve(PanelC)),
  } satisfies Record<Id, () => Promise<ComponentType>>;
}

describe("createPanelCache", () => {
  it("has nothing before a load and every requested panel after it, in request order", async () => {
    const cache = createPanelCache<Id>("test", immediateLoaders());
    expect(cache.peek(["a"])).toBeNull();
    await cache.load(["b", "a"]);
    expect(cache.peek(["b", "a"])).toEqual([
      { id: "b", Component: PanelB },
      { id: "a", Component: PanelA },
    ]);
    expect(cache.peek(["a", "c"])).toBeNull();
  });

  it("imports each panel once, however often and however concurrently it is asked for", async () => {
    const loaders = immediateLoaders();
    const cache = createPanelCache<Id>("test", loaders);
    await Promise.all([cache.load(["a"]), cache.load(["a", "b"])]);
    await cache.load(["a", "b"]);
    expect(loaders.a).toHaveBeenCalledTimes(1);
    expect(loaders.b).toHaveBeenCalledTimes(1);
    expect(loaders.c).not.toHaveBeenCalled();
  });

  it("does not remember a failed import: the next load imports again", async () => {
    const loaders = immediateLoaders();
    loaders.a.mockRejectedValueOnce(new Error("chunk missing"));
    const cache = createPanelCache<Id>("test", loaders);
    await expect(cache.load(["a"])).rejects.toThrow("chunk missing");
    expect(cache.peek(["a"])).toBeNull();
    await cache.load(["a"]);
    expect(cache.peek(["a"])).toEqual([{ id: "a", Component: PanelA }]);
    expect(loaders.a).toHaveBeenCalledTimes(2);
  });
});

describe("usePanels", () => {
  it("is loading until every requested panel has arrived, then ready", async () => {
    const a = deferred<ComponentType>();
    const b = deferred<ComponentType>();
    const cache = createPanelCache<Id>("test", {
      a: () => a.promise,
      b: () => b.promise,
      c: () => Promise.resolve(PanelC),
    });
    const { result } = renderHook(() => usePanels(cache, ["a", "b"]));
    expect(result.current.status).toBe("loading");

    await act(async () => a.resolve(PanelA));
    expect(result.current.status).toBe("loading");

    await act(async () => b.resolve(PanelB));
    expect(result.current).toEqual({
      status: "ready",
      panels: [
        { id: "a", Component: PanelA },
        { id: "b", Component: PanelB },
      ],
    });
  });

  it("is ready on the first render when the panels are already loaded", async () => {
    const cache = createPanelCache<Id>("test", immediateLoaders());
    await cache.load(["c"]);
    const { result } = renderHook(() => usePanels(cache, ["c"]));
    expect(result.current).toEqual({ status: "ready", panels: [{ id: "c", Component: PanelC }] });
  });

  it("reports a failed import and loads afresh on retry", async () => {
    const loaders = immediateLoaders();
    loaders.b.mockRejectedValueOnce(new Error("chunk missing"));
    const cache = createPanelCache<Id>("test", loaders);
    const { result } = renderHook(() => usePanels(cache, ["b"]));

    await waitFor(() => expect(result.current.status).toBe("failed"));
    const failed = result.current;
    if (failed.status !== "failed") throw new Error("expected a failure");

    act(() => failed.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loaders.b).toHaveBeenCalledTimes(2);
  });

  it("loads again, rather than replaying the failure, when a failed request is asked for a second time", async () => {
    const loaders = immediateLoaders();
    loaders.a.mockRejectedValueOnce(new Error("chunk missing"));
    const cache = createPanelCache<Id>("test", loaders);
    const { result, rerender } = renderHook(({ ids }: { ids: Id[] }) => usePanels(cache, ids), {
      initialProps: { ids: ["a"] },
    });
    await waitFor(() => expect(result.current.status).toBe("failed"));

    rerender({ ids: ["b"] });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ ids: ["a"] });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loaders.a).toHaveBeenCalledTimes(2);
  });

  it("does not report a superseded request's failure against the current one", async () => {
    const a = deferred<ComponentType>();
    const cache = createPanelCache<Id>("test", {
      a: () => a.promise,
      b: () => Promise.resolve(PanelB),
      c: () => Promise.resolve(PanelC),
    });
    const { result, rerender } = renderHook(({ ids }: { ids: Id[] }) => usePanels(cache, ids), {
      initialProps: { ids: ["a"] },
    });
    rerender({ ids: ["b"] });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => a.reject(new Error("late failure")));
    expect(result.current).toEqual({ status: "ready", panels: [{ id: "b", Component: PanelB }] });
  });
});
