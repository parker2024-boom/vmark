// @vitest-environment node
/**
 * The three Finder-open defects that came from copying the navigation flows
 * into a hook closure and letting the copies drift.
 *
 * 1. MEDIA. `loadFileIntoTab` always called `readTextFile`, so a `.png`
 *    double-clicked in Finder was read as UTF-8 and errored. The identical
 *    file opened via Cmd+O worked, because that path routes through
 *    `tryOpenMediaFile` first.
 * 2. DEDUP. `createTab` deduplicates by path. When it returned a tab that
 *    already existed — created by a concurrent open whose own read was still
 *    in flight — the branch loaded into it anyway, overwriting content that
 *    could be dirty, and on failure detached a tab it never created.
 * 3. SIZE GATE ON MEDIA. A 4 GB video was routed through the large-file
 *    confirmation even though media tabs are path-only and never read a byte.
 *
 * The tab and document stores and the media opener are the real ones; the
 * text read (`loadFileIntoTab`) is the hook's collaborator, passed in.
 *
 * @coordinates-with services/navigation/finderOpenBranches.ts
 * @module services/navigation/finderOpenBranches.test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockRouteOpenBySize,
  mockOpenWorkspaceWithConfig,
  mockMarkLargeSource,
} = vi.hoisted(() => ({
  mockRouteOpenBySize: vi.fn(),
  mockOpenWorkspaceWithConfig: vi.fn(),
  mockMarkLargeSource: vi.fn(),
}));

vi.mock("@/services/workspaces/openWorkspaceWithConfig", () => ({
  openWorkspaceWithConfig: (...a: unknown[]) => mockOpenWorkspaceWithConfig(...a),
}));
vi.mock("@/services/workspaces/fileOwnership", () => ({
  applyFileOwnershipAfterOpen: vi.fn(),
}));
vi.mock("@/services/navigation/largeFileRouting", () => ({
  routeOpenBySize: (...a: unknown[]) => mockRouteOpenBySize(...a),
}));
vi.mock("@/lib/formats/markdownLargeFile", () => ({
  maybeMarkLargeMarkdownAsSource: (...a: unknown[]) => mockMarkLargeSource(...a),
}));
vi.mock("@/utils/debug", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/debug")>()),
  finderFileOpenError: vi.fn(),
}));

import {
  createNewTabForFile,
  replaceTabWithFile,
  withSizeGateAndIndicator,
  type FinderBranchContext,
} from "./finderOpenBranches";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore, useFileLoadStore } from "@/stores/documentStore";
import { useClosedTabScopesStore } from "@/stores/tabStoreClosedScopes";
import { rebootstrapFormats } from "@/lib/formats/registryBootstrap";

const mockLoadFileIntoTab = vi.fn(async (_tabId: string, _path: string) => {});
const ctx: FinderBranchContext = {
  windowLabel: "main",
  isCancelled: () => false,
  onOpenFailure: vi.fn(),
  loadFileIntoTab: (tabId, path) => mockLoadFileIntoTab(tabId, path),
};

const MD = "/w/doc.md";
const PNG = "/w/photo.png";

const tabIds = () => useTabStore.getState().getTabsByWindow("main").map((t) => t.id);
const tabAt = (path: string) => useTabStore.getState().findTabByPath("main", path);
const activeTabId = () => useTabStore.getState().activeTabId["main"];
const documentOf = (tabId: string) => useDocumentStore.getState().getDocument(tabId);
/** A clean untitled tab — the one the replace branch reuses. */
const untitledTab = () => useTabStore.getState().createTab("main", null);

beforeEach(() => {
  vi.clearAllMocks();
  // The media branch resolves the tab's format through the registry.
  rebootstrapFormats();
  useTabStore.getState().removeWindow("main");
  useDocumentStore.setState({ documents: {} });
  useClosedTabScopesStore.getState().resetClosedScopes();
  useFileLoadStore.getState().endLoad();
  mockLoadFileIntoTab.mockResolvedValue(undefined);
  mockRouteOpenBySize.mockResolvedValue({ proceed: true, sizeBytes: 100, forceSourceMode: false });
});

describe("media never reaches readTextFile", () => {
  it("create branch: a .png opens as a media tab, not a text read", async () => {
    const result = await createNewTabForFile(ctx, PNG, null, false);

    expect(mockLoadFileIntoTab).not.toHaveBeenCalled();
    // One tab — the media opener's — path-only, with an EMPTY document.
    const tab = tabAt(PNG);
    expect(tabIds()).toEqual([tab?.id]);
    expect(tab).toMatchObject({ kind: "document", formatId: "media" });
    expect(documentOf(tab?.id ?? "")).toMatchObject({ content: "", filePath: PNG });
    expect(result).toBeNull();
  });

  it("replace branch: a .mp4 replaces the clean tab as media", async () => {
    const tabId = untitledTab();

    const result = await replaceTabWithFile(ctx, { tabId }, "/w/clip.mp4", null, true);

    expect(mockLoadFileIntoTab).not.toHaveBeenCalled();
    expect(useTabStore.getState().findTabById(tabId)).toMatchObject({
      filePath: "/w/clip.mp4",
      formatId: "media",
    });
    expect(documentOf(tabId)).toMatchObject({ content: "", filePath: "/w/clip.mp4" });
    expect(result).toBe(tabId);
  });

  it("markdown still goes through the text read", async () => {
    const result = await createNewTabForFile(ctx, MD, null, false);

    const tabId = tabAt(MD)?.id;
    expect(mockLoadFileIntoTab).toHaveBeenCalledWith(tabId, MD);
    expect(result).toBe(tabId);
    // The media opener would have initialised an empty document; nothing did.
    expect(documentOf(tabId ?? "")).toBeUndefined();
  });

  it(".svg is text, not media — it is a registered split-pane format", async () => {
    await createNewTabForFile(ctx, "/w/icon.svg", null, false);

    const tabId = tabAt("/w/icon.svg")?.id;
    expect(mockLoadFileIntoTab).toHaveBeenCalledWith(tabId, "/w/icon.svg");
    expect(documentOf(tabId ?? "")).toBeUndefined();
  });
});

describe("media skips the size gate", () => {
  it("a huge video is never routed for large-file confirmation", async () => {
    // Path-only tabs read no bytes, so there is nothing to refuse or confirm.
    await withSizeGateAndIndicator(ctx, PNG, async () => null);
    expect(mockRouteOpenBySize).not.toHaveBeenCalled();
  });

  it("a text file still is", async () => {
    await withSizeGateAndIndicator(ctx, MD, async () => "t");
    expect(mockRouteOpenBySize).toHaveBeenCalledWith(MD);
  });

  it("a refused text file does not run its branch", async () => {
    mockRouteOpenBySize.mockResolvedValue({ proceed: false, sizeBytes: 0, forceSourceMode: false });
    const run = vi.fn(async () => "t");

    await withSizeGateAndIndicator(ctx, MD, run);

    expect(run).not.toHaveBeenCalled();
  });
});

describe("createTab deduplication race", () => {
  it("activates the existing tab instead of overwriting it", async () => {
    // A concurrent open created the tab; its own read is still in flight, so
    // the branch resolver's document-based check could not see it. Another
    // tab has focus since.
    const concurrent = useTabStore.getState().createTab("main", MD);
    useTabStore.getState().createTab("main", "/w/other.md");

    const result = await createNewTabForFile(ctx, MD, null, false);

    expect(mockLoadFileIntoTab).not.toHaveBeenCalled();
    expect(activeTabId()).toBe(concurrent);
    expect(result).toBeNull();
  });

  it("never detaches a tab it did not create", async () => {
    const theirs = useTabStore.getState().createTab("main", MD);
    // Were the branch to load into their tab, this failure would detach it.
    mockLoadFileIntoTab.mockRejectedValue(new Error("EACCES"));

    await createNewTabForFile(ctx, MD, null, false);

    expect(tabIds()).toEqual([theirs]);
  });

  it("creates normally when no tab holds that path", async () => {
    const result = await createNewTabForFile(ctx, MD, null, false);

    expect(tabAt(MD)).toMatchObject({ kind: "document", filePath: MD });
    expect(result).toBe(tabAt(MD)?.id);
    expect(activeTabId()).toBe(result);
  });

  it("detaches its OWN orphan when the read fails", async () => {
    mockLoadFileIntoTab.mockRejectedValue(new Error("EACCES"));

    const result = await createNewTabForFile(ctx, MD, null, false);

    // The tab it created and loaded into is gone — detached, not closed, so it
    // is not offered back by Reopen Closed Tab.
    const [orphan] = mockLoadFileIntoTab.mock.calls[0];
    expect(useTabStore.getState().findTabById(orphan)).toBeNull();
    expect(tabIds()).toEqual([]);
    expect(useClosedTabScopesStore.getState().scopesByWindow["main"]).toBeUndefined();
    expect(ctx.onOpenFailure).toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("cancellation", () => {
  it("stops before creating a tab when the hook already unmounted", async () => {
    const cancelled: FinderBranchContext = { ...ctx, isCancelled: () => true };

    const result = await createNewTabForFile(cancelled, MD, null, false);

    expect(tabIds()).toEqual([]);
    expect(result).toBeNull();
  });

  it("stops the replace branch after the workspace open", async () => {
    const cancelled: FinderBranchContext = { ...ctx, isCancelled: () => true };

    const result = await replaceTabWithFile(cancelled, { tabId: untitledTab() }, MD, "/w", true);

    expect(mockOpenWorkspaceWithConfig).toHaveBeenCalled();
    expect(mockLoadFileIntoTab).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

// #1330 — the replace branch is reached for a window that already owns a
// workspace (rail mode, or a file inside the current root). Adopting the
// incoming root there re-points the sidebar at the file's folder and the user
// loses the tree they were looking at, with no tab left to navigate back from.
describe("replacing the untitled tab does not re-root the window", () => {
  it("skips the workspace open when the branch says not to adopt", async () => {
    const tabId = untitledTab();

    await replaceTabWithFile(ctx, { tabId }, MD, "/w/sub", false);

    expect(mockOpenWorkspaceWithConfig).not.toHaveBeenCalled();
    expect(mockLoadFileIntoTab).toHaveBeenCalledWith(tabId, MD);
  });

  it("skips it for media too — the short-circuit must not smuggle it back in", async () => {
    const tabId = untitledTab();

    await replaceTabWithFile(ctx, { tabId }, PNG, "/w/sub", false);

    expect(mockOpenWorkspaceWithConfig).not.toHaveBeenCalled();
    expect(useTabStore.getState().findTabById(tabId)).toMatchObject({ filePath: PNG, formatId: "media" });
    expect(documentOf(tabId)).toMatchObject({ content: "", filePath: PNG });
  });

  it("still adopts when the window has no workspace of its own", async () => {
    await replaceTabWithFile(ctx, { tabId: untitledTab() }, MD, "/w", true);

    expect(mockOpenWorkspaceWithConfig).toHaveBeenCalledWith("/w", { windowLabel: "main" });
  });
});

describe("the progress indicator is never left spinning", () => {
  const BIG = { proceed: true, sizeBytes: 50_000_000, forceSourceMode: false };
  /** Run a branch that records whether the indicator was on while it ran. */
  const branchLanding = (landed: string | null) => {
    const seen = { indicatorOn: false };
    const run = async () => {
      seen.indicatorOn = useFileLoadStore.getState().active;
      return landed;
    };
    return { seen, run };
  };

  it("clears the indicator when the branch lands nothing", async () => {
    // A read failure, a detached orphan, or a dedup all return null. Without
    // this the spinner outlives the operation that started it.
    mockRouteOpenBySize.mockResolvedValue(BIG);
    const { seen, run } = branchLanding(null);

    await withSizeGateAndIndicator(ctx, MD, run);

    expect(seen.indicatorOn).toBe(true);
    expect(useFileLoadStore.getState().active).toBe(false);
  });

  it("does not clear it when content landed — the loader owns its own end", async () => {
    mockRouteOpenBySize.mockResolvedValue(BIG);

    await withSizeGateAndIndicator(ctx, MD, async () => "tab-1");

    expect(useFileLoadStore.getState()).toMatchObject({ active: true, filename: "doc.md" });
    expect(mockMarkLargeSource).toHaveBeenCalledWith("tab-1", MD, false);
  });

  it("shows no indicator for a small file, and clears nothing", async () => {
    mockRouteOpenBySize.mockResolvedValue({ proceed: true, sizeBytes: 10, forceSourceMode: false });
    // Another open's indicator is up; this one must neither replace nor clear it.
    const other = useFileLoadStore.getState().startLoad("other.md", 1);

    await withSizeGateAndIndicator(ctx, MD, async () => null);

    expect(useFileLoadStore.getState()).toMatchObject({ active: true, filename: "other.md", loadId: other });
  });

  it("shows no indicator when the route forces Source mode", async () => {
    // Forced-source means the file is huge; the Source surface renders it
    // without the load the indicator would be reporting on.
    mockRouteOpenBySize.mockResolvedValue({ ...BIG, forceSourceMode: true });
    const { seen, run } = branchLanding("tab-1");

    await withSizeGateAndIndicator(ctx, MD, run);

    expect(seen.indicatorOn).toBe(false);
    expect(useFileLoadStore.getState().active).toBe(false);
    expect(mockMarkLargeSource).toHaveBeenCalledWith("tab-1", MD, true);
  });

  it("stops after the size route when the hook unmounted mid-check", async () => {
    mockRouteOpenBySize.mockResolvedValue(BIG);
    const run = vi.fn(async () => "t");

    await withSizeGateAndIndicator({ ...ctx, isCancelled: () => true }, MD, run);

    expect(run).not.toHaveBeenCalled();
  });
});
