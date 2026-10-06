// @vitest-environment node
// WI-RA20.1, WI-RA20.2 — closing a pinned tab deliberately: the pin is lifted
// for that one close and, when the close is refused, put back in the SAME
// place in the strip. Real tab store; the closer is the injected boundary.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { bootstrapFormats } from "@/lib/formats";
import { useTabStore } from "@/stores/tabStore";
import { closeLiftingPin } from "./closeLiftingPin";

const WINDOW = "main";

function seed(count: number, pinned: readonly number[]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(useTabStore.getState().createTab(WINDOW));
  for (const i of pinned) useTabStore.getState().togglePin(WINDOW, ids[i]);
  return ids;
}

const strip = () =>
  useTabStore.getState().getTabsByWindow(WINDOW).map((tab) => `${tab.id}${tab.isPinned ? "*" : ""}`);
const refuse = async () => false;
const closeForReal = async (id: string) => useTabStore.getState().closeTab(WINDOW, id);

beforeAll(() => {
  bootstrapFormats();
});

beforeEach(() => {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
});

describe("closeLiftingPin", () => {
  it.each([0, 1, 2])("restores pinned tab #%i to its exact place when the close is refused", async (n) => {
    const ids = seed(5, [0, 1, 2]);
    const before = strip();
    expect(await closeLiftingPin(WINDOW, ids[n], refuse)).toBe(false);
    expect(strip()).toEqual(before);
  });

  it("closes a pinned tab the lifecycle would otherwise refuse", async () => {
    const ids = seed(3, [1]);
    const pinnedId = useTabStore.getState().getTabsByWindow(WINDOW)[0].id;
    expect(pinnedId).toBe(ids[1]);
    expect(await closeLiftingPin(WINDOW, pinnedId, closeForReal)).toBe(true);
    expect(strip()).toEqual([ids[0], ids[2]]);
  });

  it("hands the closer an unpinned tab, which is why the lifecycle accepts it", async () => {
    const [id] = seed(1, [0]);
    let pinnedDuringClose: boolean | undefined;
    await closeLiftingPin(WINDOW, id, async () => {
      pinnedDuringClose = useTabStore.getState().getTabsByWindow(WINDOW)[0].isPinned;
      return false;
    });
    expect(pinnedDuringClose).toBe(false);
  });

  it("leaves an unpinned tab unpinned when its close is refused", async () => {
    const ids = seed(3, [0]);
    const before = strip();
    expect(await closeLiftingPin(WINDOW, ids[2], refuse)).toBe(false);
    expect(strip()).toEqual(before);
  });

  it("treats a tab that no longer exists as closed without calling the closer", async () => {
    seed(1, []);
    let called = false;
    expect(await closeLiftingPin(WINDOW, "gone", async () => { called = true; return false; })).toBe(true);
    expect(called).toBe(false);
  });

  it("keeps a pin the user set again during the save prompt, once", async () => {
    const ids = seed(3, [0, 1]);
    const before = strip();
    expect(
      await closeLiftingPin(WINDOW, ids[0], async (id) => {
        useTabStore.getState().togglePin(WINDOW, id);
        return false;
      }),
    ).toBe(false);
    expect(strip().filter((entry) => entry.endsWith("*"))).toHaveLength(2);
    expect(new Set(strip())).toEqual(new Set(before));
  });

  it("restores to the front when its left neighbour closed during the prompt", async () => {
    const ids = seed(3, [0, 1]);
    const [first, second] = useTabStore.getState().getTabsByWindow(WINDOW).map((tab) => tab.id);
    expect(
      await closeLiftingPin(WINDOW, second, async () => {
        useTabStore.getState().togglePin(WINDOW, first);
        useTabStore.getState().closeTab(WINDOW, first);
        return false;
      }),
    ).toBe(false);
    expect(strip()).toEqual([`${second}*`, ids[2]]);
  });
});
