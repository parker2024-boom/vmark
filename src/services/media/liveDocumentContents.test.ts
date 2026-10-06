// @vitest-environment node
/**
 * The buffers that keep a neighbour's just-pasted image from being deleted.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { liveContentsExcluding } from "./liveDocumentContents";

function reset() {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
}

/** Open a document in a tab with a chosen id, in `windowLabel`. */
function open(tabId: string, content: string, filePath: string | null, windowLabel = "main"): void {
  useTabStore.setState((state) => ({
    tabs: {
      ...state.tabs,
      [windowLabel]: [
        ...(state.tabs[windowLabel] ?? []),
        { kind: "document", id: tabId, filePath, title: tabId, isPinned: false, formatId: "markdown" },
      ],
    },
  }));
  useDocumentStore.getState().initDocument(tabId, content, filePath);
}

describe("liveContentsExcluding", () => {
  beforeEach(reset);

  it("is empty when nothing is open", () => {
    expect(liveContentsExcluding().size).toBe(0);
  });

  it("maps every open document by path", () => {
    open("t1", "A", "/tmp/a.md");
    open("t2", "B", "/tmp/b.md");

    const live = liveContentsExcluding();

    expect(live.get("/tmp/a.md")).toBe("A");
    expect(live.get("/tmp/b.md")).toBe("B");
  });

  it("returns the UNSAVED buffer, not the saved content", () => {
    open("t1", "saved", "/tmp/a.md");
    useDocumentStore.getState().setEditorContent("t1", "![](./assets/images/pasted.png)");

    expect(liveContentsExcluding().get("/tmp/a.md")).toBe("![](./assets/images/pasted.png)");
  });

  it("omits the excluded tabs", () => {
    open("t1", "A", "/tmp/a.md");
    open("t2", "B", "/tmp/b.md");

    const live = liveContentsExcluding(new Set(["t1"]));

    expect(live.has("/tmp/a.md")).toBe(false);
    expect(live.get("/tmp/b.md")).toBe("B");
  });

  it("carries untitled documents under a synthetic key", () => {
    // A never-saved buffer can hold an absolute-path reference that exists
    // nowhere on disk — omitting it deleted the image (review finding). The
    // synthetic key never matches a directory filter, so it acts purely as
    // extra reference evidence.
    open("t1", "![](/w/assets/images/x.png)", null);
    expect(liveContentsExcluding().get("untitled:t1")).toBe("![](/w/assets/images/x.png)");
  });

  it("prefers the dirty buffer when two tabs hold one path", () => {
    open("clean", "saved", "/tmp/a.md", "main");
    open("dirty", "saved", "/tmp/a.md", "doc-1");
    useDocumentStore.getState().setEditorContent("dirty", "![](./assets/images/pasted.png)");

    // Whichever order the tabs come in, the buffer carrying the extra
    // reference must win — the clean twin would leave that image unprotected.
    expect(liveContentsExcluding().get("/tmp/a.md")).toBe("![](./assets/images/pasted.png)");
  });

  it("keeps the dirty buffer even when the clean twin comes last", () => {
    open("dirty", "saved", "/tmp/a.md", "main");
    useDocumentStore.getState().setEditorContent("dirty", "![](./assets/images/pasted.png)");
    open("clean", "saved", "/tmp/a.md", "doc-1");

    expect(liveContentsExcluding().get("/tmp/a.md")).toBe("![](./assets/images/pasted.png)");
  });
});

// WI-RA1C.4 — a buffer here REPLACES the file on disk as the scan's evidence
// for that path. Only an open document may do that: one left behind without a
// tab holds text nobody can see or save, and trusting it over the file deletes
// an image the file on disk still references.
describe("liveContentsExcluding — only open documents stand in for their files", () => {
  beforeEach(reset);

  it("omits a document that has no tab, so the scan reads that file from disk", () => {
    open("t1", "A", "/tmp/a.md");
    // Left behind with no tab; its buffer has lost a reference the file holds.
    useDocumentStore.getState().initDocument("ghost", "text without the image", "/tmp/ghost.md");

    const live = liveContentsExcluding();

    expect(live.has("/tmp/ghost.md")).toBe(false);
    expect([...live.keys()]).toEqual(["/tmp/a.md"]);
  });

  it("does not let a tabless twin override the open tab's buffer for the same path", () => {
    open("t1", "![](./assets/images/kept.png)", "/tmp/a.md");
    useDocumentStore.getState().initDocument("ghost", "saved", "/tmp/a.md");
    useDocumentStore.getState().setEditorContent("ghost", "dirty, and without the image");

    expect(liveContentsExcluding().get("/tmp/a.md")).toBe("![](./assets/images/kept.png)");
  });

  it("omits an untitled document that has no tab", () => {
    useDocumentStore.getState().initDocument("ghost", "![](/w/assets/images/x.png)", null);

    expect(liveContentsExcluding().size).toBe(0);
  });

  it("omits a document whose tab was closed, even while the document remains", () => {
    open("t1", "A", "/tmp/a.md");
    open("t2", "B", "/tmp/b.md");

    // No tab-state cleanup runs in this test, so the document stays behind.
    useTabStore.getState().closeTab("main", "t2");

    expect(useDocumentStore.getState().getDocument("t2")).toBeDefined();
    expect([...liveContentsExcluding().keys()]).toEqual(["/tmp/a.md"]);
  });
});

// WI-10 — the editor syncs to the store on a DEBOUNCE. Reading before it
// settles misses the reference of a just-pasted image, exactly when a
// brand-new file has a single reference.
describe("liveContentsExcluding — flushes pending editor state first", () => {
  beforeEach(reset);

  it("sees an edit that was still in the editor's debounce window", async () => {
    const { registerWysiwygFlusher } = await import("@/utils/wysiwygFlush");
    open("t1", "old", "/tmp/a.md");
    // The mounted editor holds newer content than the store.
    registerWysiwygFlusher("t1", () => {
      useDocumentStore.getState().setEditorContent("t1", "![](./assets/images/pasted.png)");
    });

    const live = liveContentsExcluding();

    expect(live.get("/tmp/a.md")).toBe("![](./assets/images/pasted.png)");
    registerWysiwygFlusher("t1", null);
  });

  it("survives a throwing flusher", async () => {
    const { registerWysiwygFlusher } = await import("@/utils/wysiwygFlush");
    open("t1", "content", "/tmp/a.md");
    registerWysiwygFlusher("t1", () => {
      throw new Error("editor already unmounted");
    });

    expect(() => liveContentsExcluding()).not.toThrow();
    expect(liveContentsExcluding().get("/tmp/a.md")).toBe("content");
    registerWysiwygFlusher("t1", null);
  });
});
