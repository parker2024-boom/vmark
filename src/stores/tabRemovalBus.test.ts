// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { onTabRemoved, notifyTabRemoved } from "./tabRemovalBus";
import { useTabStore } from "./tabStore";

describe("tabRemovalBus (#1081)", () => {
  it("delivers removal notifications to subscribers", () => {
    const seen: Array<[string, string]> = [];
    const off = onTabRemoved((w, t) => seen.push([w, t]));
    notifyTabRemoved("main", "tab-1");
    expect(seen).toEqual([["main", "tab-1"]]);
    off();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const off = onTabRemoved(listener);
    off();
    notifyTabRemoved("main", "tab-1");
    expect(listener).not.toHaveBeenCalled();
  });

  it("fans out to every active subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onTabRemoved(a);
    const offB = onTabRemoved(b);
    notifyTabRemoved("w", "t");
    expect(a).toHaveBeenCalledWith("w", "t", undefined);
    expect(b).toHaveBeenCalledWith("w", "t", undefined);
    offA();
    offB();
  });
});

// WI-RA1B.1 — every way a tab leaves the tab store is announced. `removeWindow`
// used to drop a window's whole tab list in silence, so nothing downstream
// (pane state, per-tab cleanup, native browser views) heard about those tabs.
describe("tabStore announces every removal", () => {
  function recordRemovals(): { seen: Array<[string, string, string | undefined]>; off: () => void } {
    const seen: Array<[string, string, string | undefined]> = [];
    const off = onTabRemoved((w, t, info) => seen.push([w, t, info?.reason]));
    return { seen, off };
  }

  it("removeWindow announces each tab it held, pinned or not, with reason `window`", () => {
    useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
    const a = useTabStore.getState().createTab("main", "/repo/a.md");
    const b = useTabStore.getState().createTab("main", null);
    useTabStore.getState().togglePin("main", a);
    const elsewhere = useTabStore.getState().createTab("doc-1", "/repo/c.md");
    const { seen, off } = recordRemovals();

    useTabStore.getState().removeWindow("main");
    off();

    expect(seen).toEqual([
      ["main", a, "window"],
      ["main", b, "window"],
    ]);
    // Announced AFTER the removal: a listener sees the tabs already gone.
    expect(useTabStore.getState().tabs.main).toBeUndefined();
    expect(useTabStore.getState().findTabById(elsewhere)).not.toBeNull();
  });

  it("removeWindow on an empty or unknown window announces nothing", () => {
    useTabStore.setState({ tabs: { main: [] }, activeTabId: { main: null }, untitledCounter: 0 });
    const { seen, off } = recordRemovals();

    useTabStore.getState().removeWindow("main");
    useTabStore.getState().removeWindow("no-such-window");
    off();

    expect(seen).toEqual([]);
  });

  it("closeTab and detachTab keep their own reasons, and a refused close announces nothing", () => {
    useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
    const closed = useTabStore.getState().createTab("main", "/repo/a.md");
    const detached = useTabStore.getState().createTab("main", "/repo/b.md");
    const pinned = useTabStore.getState().createTab("main", "/repo/c.md");
    useTabStore.getState().togglePin("main", pinned);
    const { seen, off } = recordRemovals();

    useTabStore.getState().closeTab("main", closed);
    useTabStore.getState().detachTab("main", detached);
    useTabStore.getState().closeTab("main", pinned);
    off();

    expect(seen).toEqual([
      ["main", closed, "close"],
      ["main", detached, "detach"],
    ]);
  });
});
