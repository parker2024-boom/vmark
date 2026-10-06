// @vitest-environment node
// WI-RA1C.4 — clearing a window before a hot-exit restore drops its tabs
// through the tab store, and that alone frees their state: the tab-state
// cleanup hears each removal. Real stores, with the cleanup running as it
// does for a window's whole lifetime.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTabStore } from "@/stores/tabStore";
import {
  useDocumentStore,
  useRevisionStore,
  useUnifiedHistoryStore,
} from "@/stores/documentStore";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import { clearExistingWindowTabs } from "./restoreTabsHelpers";

const MAIN = "main";
const OTHER = "doc-1";

function openTab(windowLabel: string, filePath: string | null, content: string): string {
  const tabId = useTabStore.getState().createTab(windowLabel, filePath);
  useDocumentStore.getState().initDocument(tabId, content, filePath);
  useRevisionStore.getState().getRevision(tabId);
  return tabId;
}

/** Give the tab an undo checkpoint, the way an edit across a mode switch does. */
function addHistory(tabId: string): void {
  useUnifiedHistoryStore.getState().createCheckpoint(tabId, {
    markdown: "earlier text",
    mode: "wysiwyg",
    cursorInfo: null,
  });
}

let stopCleanup: () => void;

beforeEach(() => {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
  useRevisionStore.setState({ revisions: {} });
  useUnifiedHistoryStore.setState({ documents: {} });
  stopCleanup = startTabStateCleanup();
});

afterEach(() => {
  stopCleanup();
});

describe("clearExistingWindowTabs", () => {
  it("drops every tab of the window and frees each tab's state", () => {
    const first = openTab(MAIN, "/w/a.md", "A");
    const second = openTab(MAIN, null, "未保存的草稿");
    addHistory(first);
    expect(useUnifiedHistoryStore.getState().documents[first]).toBeDefined();

    clearExistingWindowTabs(MAIN);

    expect(useTabStore.getState().getTabsByWindow(MAIN)).toEqual([]);
    for (const tabId of [first, second]) {
      expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
      expect(useRevisionStore.getState().revisions[tabId]).toBeUndefined();
      expect(useUnifiedHistoryStore.getState().documents[tabId]).toBeUndefined();
    }
  });

  it("drops a pinned tab too: the restore replaces the whole window", () => {
    const pinned = openTab(MAIN, "/w/pinned.md", "P");
    useTabStore.getState().togglePin(MAIN, pinned);

    clearExistingWindowTabs(MAIN);

    expect(useTabStore.getState().findTabById(pinned)).toBeNull();
    expect(useDocumentStore.getState().getDocument(pinned)).toBeUndefined();
  });

  it("leaves another window's tabs and their state alone", () => {
    openTab(MAIN, "/w/a.md", "A");
    const elsewhere = openTab(OTHER, "/w/b.md", "B");
    const revision = useRevisionStore.getState().getRevision(elsewhere);

    clearExistingWindowTabs(MAIN);

    expect(useTabStore.getState().findTabById(elsewhere)).not.toBeNull();
    expect(useDocumentStore.getState().getDocument(elsewhere)?.content).toBe("B");
    expect(useRevisionStore.getState().getRevision(elsewhere)).toBe(revision);
  });

  it("does nothing for a window that has no tabs", () => {
    const elsewhere = openTab(OTHER, "/w/b.md", "B");

    clearExistingWindowTabs(MAIN);
    clearExistingWindowTabs("no-such-window");

    expect(useTabStore.getState().findTabById(elsewhere)).not.toBeNull();
    expect(Object.keys(useDocumentStore.getState().documents)).toEqual([elsewhere]);
  });
});
