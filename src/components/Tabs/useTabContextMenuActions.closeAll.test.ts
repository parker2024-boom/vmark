// WI-RA19.2, WI-RA20.1 — "Close All" from the tab menu, with pinned tabs.
// It used to hand the pinned ids to the bulk close; the close lifecycle
// refuses a pinned tab and stops at the first refusal, and pinned tabs sit at
// the left of the strip, so with any tab pinned Close All closed nothing.
// It now asks once and, on confirmation, closes the pinned tabs as well.
// Runs against the REAL tab store and close lifecycle — the sibling suite
// mocks the lifecycle, which is how the refusal went unnoticed.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { ask } from "@tauri-apps/plugin-dialog";

import { bootstrapFormats } from "@/lib/formats";
import { useTabStore } from "@/stores/tabStore";
import { useTabContextMenuActions, type TabMenuItem } from "./useTabContextMenuActions";

const WINDOW = "main";

function seed(pinned: readonly number[], count: number): string[] {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(useTabStore.getState().createTab(WINDOW));
  for (const i of pinned) useTabStore.getState().togglePin(WINDOW, ids[i]);
  return ids;
}

function closeAllItem(): TabMenuItem {
  const tabs = useTabStore.getState().getTabsByWindow(WINDOW);
  const tab = tabs[0];
  if (!tab) throw new Error("no tabs seeded");
  const { result } = renderHook(() =>
    useTabContextMenuActions({
      tab,
      tabs,
      filePath: null,
      windowLabel: WINDOW,
      workspaceRoot: null,
      revealLabel: "Reveal",
      closeShortcutLabel: "",
      onClose: () => undefined,
    }),
  );
  const item = result.current.find((entry) => entry.id === "closeAll");
  if (!item) throw new Error("no closeAll item");
  return item;
}

const openIds = () => useTabStore.getState().getTabsByWindow(WINDOW).map((t) => t.id);

beforeAll(() => {
  bootstrapFormats();
});

beforeEach(() => {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  vi.mocked(ask).mockReset();
  vi.mocked(ask).mockResolvedValue(false);
});

describe("Close All with pinned tabs", () => {
  it("closes every tab, the pinned one included, once confirmed", async () => {
    seed([0], 3);
    vi.mocked(ask).mockResolvedValueOnce(true);
    await closeAllItem().action();
    expect(openIds()).toEqual([]);
  });

  it("closes nothing and keeps every pin when the confirmation is declined", async () => {
    const ids = seed([0, 2], 4);
    const before = openIds();
    await closeAllItem().action();
    expect(openIds()).toEqual(before);
    expect(new Set(before)).toEqual(new Set(ids));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("closes everything when nothing is pinned", async () => {
    seed([], 3);
    await closeAllItem().action();
    expect(openIds()).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("stays enabled when every tab is pinned, and closes them once confirmed", async () => {
    seed([0, 1], 2);
    const item = closeAllItem();
    expect(item.disabled).toBeFalsy();
    vi.mocked(ask).mockResolvedValueOnce(true);
    await item.action();
    expect(openIds()).toEqual([]);
  });
});
