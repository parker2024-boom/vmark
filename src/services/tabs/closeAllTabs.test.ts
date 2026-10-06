// @vitest-environment node
// WI-RA20.1 — "Close All" closes every tab, pinned ones included, after one
// confirmation naming how many pinned tabs go. Runs the REAL tab store,
// document store and close lifecycle; only the native dialogs are stubbed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import i18n from "@/i18n";
import { closeAllTabs } from "./closeAllTabs";

const WINDOW = "main";

startTabStateCleanup();

function seed(count: number, pinned: readonly number[] = []): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = useTabStore.getState().createTab(WINDOW);
    useDocumentStore.getState().initDocument(id, "", null);
    ids.push(id);
  }
  for (const i of pinned) useTabStore.getState().togglePin(WINDOW, ids[i]);
  return ids;
}

const liveTabs = () => useTabStore.getState().getTabsByWindow(WINDOW);
const openIds = () => liveTabs().map((t) => t.id);
const pinnedIds = () => liveTabs().filter((t) => t.isPinned).map((t) => t.id);
const makeDirty = (id: string) =>
  useDocumentStore.getState().initDocument(id, "edited", null, { savedContent: "" });

beforeEach(() => {
  useTabStore.getState().removeWindow(WINDOW);
  const docs = useDocumentStore.getState();
  Object.keys(docs.documents).forEach((id) => docs.removeDocument(id));
  vi.clearAllMocks();
  vi.mocked(ask).mockResolvedValue(false);
});

describe("closeAllTabs", () => {
  it("closes everything without asking when nothing is pinned", async () => {
    seed(3);
    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(true);
    expect(openIds()).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("is a no-op that asks nothing for an empty tab list", async () => {
    expect(await closeAllTabs(WINDOW, [])).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("closes pinned and unpinned tabs once the confirmation is accepted", async () => {
    seed(4, [0, 2]);
    vi.mocked(ask).mockResolvedValueOnce(true);
    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(true);
    expect(openIds()).toEqual([]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("names the number of pinned tabs in the confirmation, with a verb button", async () => {
    seed(4, [0, 2]);
    await closeAllTabs(WINDOW, liveTabs());
    expect(ask).toHaveBeenCalledWith(
      i18n.t("dialog:closeAll.pinnedPrompt", { count: 2 }),
      expect.objectContaining({
        kind: "warning",
        okLabel: i18n.t("dialog:closeAll.confirmClose"),
        title: i18n.t("dialog:closeAll.pinnedTitle"),
      }),
    );
    expect(i18n.t("dialog:closeAll.pinnedPrompt", { count: 2 })).toContain("2");
    expect(i18n.t("dialog:closeAll.pinnedPrompt", { count: 1 })).not.toBe(
      i18n.t("dialog:closeAll.pinnedPrompt", { count: 2 }),
    );
  });

  it("closes nothing and keeps the pins when the confirmation is cancelled", async () => {
    const ids = seed(3, [1]);
    const before = openIds();
    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(false);
    expect(openIds()).toEqual(before);
    expect(pinnedIds()).toEqual([ids[1]]);
    expect(message).not.toHaveBeenCalled();
  });

  it("closes a window whose every tab is pinned", async () => {
    seed(2, [0, 1]);
    vi.mocked(ask).mockResolvedValueOnce(true);
    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(true);
    expect(openIds()).toEqual([]);
  });

  it("stops at a cancelled save prompt on a pinned tab and leaves it pinned in place", async () => {
    const ids = seed(4, [0, 1]);
    const pinnedOrder = pinnedIds();
    makeDirty(ids[0]);
    vi.mocked(ask).mockResolvedValueOnce(true);
    vi.mocked(message).mockResolvedValueOnce("Cancel");

    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(false);

    // Unpinned tabs go first, then pinned ones right to left: the clean pinned
    // tab is gone, and the dirty one refused and kept both its pin and place.
    expect(openIds()).toEqual([ids[0]]);
    expect(pinnedIds()).toEqual([ids[0]]);
    expect(pinnedOrder).toContain(ids[0]);
    expect(message).toHaveBeenCalledTimes(1);
    expect(useDocumentStore.getState().getDocument(ids[0])?.content).toBe("edited");
  });

  it("restores a refused pinned tab to its original position among the pinned tabs", async () => {
    const ids = seed(3, [0, 1, 2]);
    const pinnedOrder = pinnedIds();
    const last = pinnedOrder[pinnedOrder.length - 1];
    makeDirty(last);
    vi.mocked(ask).mockResolvedValueOnce(true);
    vi.mocked(message).mockResolvedValueOnce("Cancel");

    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(false);
    expect(openIds()).toEqual(pinnedOrder);
    expect(pinnedIds()).toEqual(pinnedOrder);
    expect(ids).toHaveLength(3);
  });

  it("stops at a cancelled save prompt on an unpinned tab before touching any pinned tab", async () => {
    const ids = seed(3, [0]);
    makeDirty(ids[1]);
    vi.mocked(ask).mockResolvedValueOnce(true);
    vi.mocked(message).mockResolvedValueOnce("Cancel");

    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(false);
    expect(openIds()).toEqual(ids);
    expect(pinnedIds()).toEqual([ids[0]]);
  });

  it("discards a dirty pinned tab when the save prompt says so", async () => {
    const ids = seed(2, [0]);
    makeDirty(ids[0]);
    vi.mocked(ask).mockResolvedValueOnce(true);
    vi.mocked(message).mockResolvedValueOnce("No");
    expect(await closeAllTabs(WINDOW, liveTabs())).toBe(true);
    expect(openIds()).toEqual([]);
  });

  it("skips a tab that was closed while the confirmation was open", async () => {
    const ids = seed(3, [0]);
    const snapshot = liveTabs();
    vi.mocked(ask).mockImplementationOnce(async () => {
      useTabStore.getState().closeTab(WINDOW, ids[2]);
      return true;
    });
    expect(await closeAllTabs(WINDOW, snapshot)).toBe(true);
    expect(openIds()).toEqual([]);
  });

  it("asks about a tab pinned after the menu's snapshot was taken, and closes it", async () => {
    const ids = seed(2);
    const snapshot = liveTabs();
    useTabStore.getState().togglePin(WINDOW, ids[1]);
    vi.mocked(ask).mockResolvedValueOnce(true);
    expect(await closeAllTabs(WINDOW, snapshot)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(openIds()).toEqual([]);
  });

  it("a second Close All while the confirmation is open joins the first", async () => {
    seed(2, [0]);
    let release: (confirmed: boolean) => void = () => undefined;
    vi.mocked(ask).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    const first = closeAllTabs(WINDOW, liveTabs());
    const second = closeAllTabs(WINDOW, liveTabs());
    release(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(openIds()).toEqual([]);
  });
});
