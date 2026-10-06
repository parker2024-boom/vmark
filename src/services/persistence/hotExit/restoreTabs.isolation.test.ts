// @vitest-environment node
/**
 * One bad tab must cost that tab, not the session.
 *
 * `restoreTabs` calls `clearExistingWindowTabs` BEFORE rebuilding — the
 * window's fallback state is destroyed first, by design, so the rebuild has a
 * clean slate. But the rebuild loop had no per-tab guard: any throw from
 * `restoreTabMetadata` or `restoreDocumentState` propagated out with the
 * fallback already gone and only some tabs rebuilt. The user opened the app to
 * a partially restored window and no indication anything was missing. No test
 * covered a mid-loop failure.
 *
 * @coordinates-with services/persistence/hotExit/restoreHelpers.ts — restoreTabs
 * @module services/persistence/hotExit/restoreTabs.isolation.test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Everything below `restoreTabs` runs real: the tab, document and UI stores,
// `restoreTabMetadata` and `restoreDocumentState`. A failure is injected the
// way it arrives in practice — as a session payload the restore cannot read.
const { mockHotExitWarn } = vi.hoisted(() => ({ mockHotExitWarn: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/utils/debug", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/debug")>()),
  hotExitLog: vi.fn(),
  hotExitWarn: (...a: unknown[]) => mockHotExitWarn(...a),
}));

import { restoreTabs } from "./restoreHelpers";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";

const WINDOW = "main";

const tab = (id: string, path: string | null) =>
  ({
    id,
    file_path: path,
    title: path ? path.slice(1) : "Untitled",
    is_pinned: false,
    format_id: "markdown",
    editing_enabled: true,
    document: { saved_content: `saved ${id}`, content: `saved ${id}`, is_dirty: false },
  }) as never;

/** A tab whose document payload is corrupt: reading it throws mid-restore. */
const corruptDocument = (id: string, path: string) => {
  const t = tab(id, path) as Record<string, unknown>;
  Object.defineProperty(t, "document", {
    get() {
      throw new Error("corrupt document payload");
    },
  });
  return t as never;
};

/** A tab whose METADATA cannot be read: the throw comes from restoreTabMetadata. */
const corruptMetadata = (id: string, path: string) => {
  const t = tab(id, path) as Record<string, unknown>;
  Object.defineProperty(t, "editing_enabled", {
    get() {
      throw new Error("bad metadata");
    },
  });
  return t as never;
};

const windowState = (tabs: unknown[]) =>
  ({ tabs, ui_state: {}, active_tab_id: null }) as never;

/** The file paths of the window's tabs, in order. */
const windowPaths = () =>
  useTabStore
    .getState()
    .getTabsByWindow(WINDOW)
    .map((t) => (t.kind === "document" ? t.filePath : null));

beforeEach(() => {
  vi.clearAllMocks();
  useTabStore.getState().removeWindow(WINDOW);
  const docs = useDocumentStore.getState();
  for (const id of Object.keys(docs.documents)) docs.removeDocument(id);
});

describe("a tab that fails to restore", () => {
  it("does not abort the tabs after it", async () => {
    const map = await restoreTabs(
      "main",
      windowState([tab("a", "/a.md"), corruptDocument("b", "/b.md"), tab("c", "/c.md")])
    );

    // a and c survived; only b was lost.
    expect([...map.keys()]).toEqual(["a", "c"]);
    expect(windowPaths()).toEqual(["/a.md", "/c.md"]);
    expect(useDocumentStore.getState().getDocument(map.get("c")!)?.content).toBe("saved c");
  });

  it("is left out of the id map, so nothing later points at a broken tab", async () => {
    const map = await restoreTabs("main", windowState([corruptDocument("a", "/a.md")]));

    expect(map.has("a")).toBe(false);
  });

  it("is detached, not left as an empty tab claiming a real file path", async () => {
    // An empty document showing "/a.md" invites the user to save over the file
    // whose content failed to load.
    await restoreTabs("main", windowState([corruptDocument("a", "/a.md")]));

    expect(windowPaths()).toEqual([]);
  });

  it("reports the shortfall rather than restoring silently", async () => {
    await restoreTabs("main", windowState([corruptDocument("a", "/a.md"), tab("b", "/b.md")]));

    expect(mockHotExitWarn).toHaveBeenCalledWith(
      expect.stringContaining("1/2"),
    );
  });

  it("survives a throw from tab METADATA restoration too, not just the document", async () => {
    const map = await restoreTabs(
      "main",
      windowState([corruptMetadata("a", "/a.md"), tab("b", "/b.md")])
    );

    expect([...map.keys()]).toEqual(["b"]);
    expect(windowPaths()).toEqual(["/b.md"]);
  });
});

describe("the happy path is unchanged", () => {
  it("maps every session tab id to its new tab id", async () => {
    const draft = { ...(tab("b", null) as object), title: "Draft" } as never;
    const map = await restoreTabs("main", windowState([tab("a", "/a.md"), draft]));

    const tabs = useTabStore.getState().getTabsByWindow(WINDOW);
    expect(tabs.map((t) => t.id)).toEqual([map.get("a"), map.get("b")]);
    expect(windowPaths()).toEqual(["/a.md", null]);
    expect(useDocumentStore.getState().getDocument(map.get("b")!)?.content).toBe("saved b");
    expect(mockHotExitWarn).not.toHaveBeenCalled();
  });

  it("still clears the window first — the rebuild needs a clean slate", async () => {
    useTabStore.getState().createTab(WINDOW, "/stale.md");
    await restoreTabs("main", windowState([tab("a", "/a.md")]));
    expect(windowPaths()).toEqual(["/a.md"]);
  });
});
