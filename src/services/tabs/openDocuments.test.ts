// @vitest-environment node
// WI-RA1C.4 — "the open documents" are the documents of live tabs. A document
// with no tab is not open: nothing may warn about it, and its buffer may not
// stand in for the file on disk.
import { beforeEach, describe, expect, it } from "vitest";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { openDirtyTabIds, openDocuments } from "./openDocuments";

const MAIN = "main";
const OTHER = "doc-1";

function openTab(windowLabel: string, filePath: string | null, content: string): string {
  const tabId = useTabStore.getState().createTab(windowLabel, filePath);
  useDocumentStore.getState().initDocument(tabId, content, filePath);
  return tabId;
}

/** A document left behind with no tab — the state every caller must survive. */
function leaveOrphan(tabId: string, content: string, filePath: string | null): void {
  useDocumentStore.getState().initDocument(tabId, content, filePath);
}

const openIds = () => openDocuments().map((open) => open.tabId);

beforeEach(() => {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
});

describe("openDocuments", () => {
  it("is empty when no tab is open", () => {
    expect(openDocuments()).toEqual([]);
  });

  it("lists the document of every tab, in every window, in tab order", () => {
    const a = openTab(MAIN, "/w/a.md", "A");
    const b = openTab(MAIN, null, "未命名");
    const c = openTab(OTHER, "/w/c.md", "C");

    expect(openIds()).toEqual([a, b, c]);
    expect(openDocuments().map((open) => open.doc.content)).toEqual(["A", "未命名", "C"]);
  });

  it("omits a document that has no tab", () => {
    const a = openTab(MAIN, "/w/a.md", "A");
    leaveOrphan("ghost", "discarded", "/w/ghost.md");

    expect(openIds()).toEqual([a]);
  });

  it("omits a tab that has no document: a browser tab, or a tab still loading", () => {
    const a = openTab(MAIN, "/w/a.md", "A");
    useTabStore.getState().createBrowserTab(MAIN, "https://example.com/", "Example");
    useTabStore.getState().createTab(MAIN, "/w/still-loading.md");

    expect(openIds()).toEqual([a]);
  });

  it("stops listing a document once its tab is closed, even while the document remains", () => {
    const a = openTab(MAIN, "/w/a.md", "A");
    const b = openTab(MAIN, "/w/b.md", "B");

    // No tab-state cleanup runs in this test, so the document stays behind.
    useTabStore.getState().closeTab(MAIN, b);

    expect(useDocumentStore.getState().getDocument(b)).toBeDefined();
    expect(openIds()).toEqual([a]);
  });
});

describe("openDirtyTabIds", () => {
  it("is empty when nothing is dirty", () => {
    openTab(MAIN, "/w/a.md", "A");

    expect(openDirtyTabIds()).toEqual([]);
  });

  it("names the open tabs with unsaved changes, across windows", () => {
    const a = openTab(MAIN, "/w/a.md", "A");
    openTab(MAIN, "/w/clean.md", "clean");
    const c = openTab(OTHER, null, "");
    useDocumentStore.getState().setEditorContent(a, "A, edited");
    useDocumentStore.getState().setEditorContent(c, "草稿");

    expect(openDirtyTabIds()).toEqual([a, c]);
  });

  it("does not name a dirty document that has no tab", () => {
    leaveOrphan("ghost", "saved", "/w/ghost.md");
    useDocumentStore.getState().setEditorContent("ghost", "edited, then discarded");

    expect(useDocumentStore.getState().documents.ghost?.isDirty).toBe(true);
    expect(openDirtyTabIds()).toEqual([]);
  });
});
