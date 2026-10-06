// @vitest-environment node
// WI-RA27.1 — opening a media file rolls back its tab when a later step throws.
/**
 * `openMediaFileInNewTab` creates the tab first and then initialises the
 * document, claims ownership and records the recent file. Any of those can
 * throw; when one does, the tab it created must not stay behind as a stray,
 * half-initialised media tab. The rollback is `detachTab`, not `closeTab`: the
 * user never had the tab, so it must not land in "recently closed". A tab
 * `createTab` deduplicated onto belongs to whoever opened it first and is
 * never removed.
 *
 * Driven through the two openers that reach it without their own rollback —
 * Cmd+O (`openFileInNewTabCore`) and the Finder create branch — on the real
 * tab, document and closed-tab stores. The failing step is the real recent
 * files store, made to throw.
 *
 * @coordinates-with services/navigation/openMediaFile.ts
 * @module services/navigation/openMediaFileRollback.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { openFileInNewTabCore } from "./fileOpen";
import { createNewTabForFile, type FinderBranchContext } from "./finderOpenBranches";
import { useTabStore, tabFilePath } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useRecentFilesStore } from "@/stores/workspaceStore";
import { useClosedTabScopesStore } from "@/stores/tabStoreClosedScopes";
import { rebootstrapFormats } from "@/lib/formats/registryBootstrap";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";

const WINDOW = "main";
const PNG = "/w/photo.png";
const failure = new Error("recent files unavailable");

const tabIds = () => useTabStore.getState().getTabsByWindow(WINDOW).map((t) => t.id);
const closedPaths = () =>
  Object.values(useClosedTabScopesStore.getState().scopesByWindow[WINDOW] ?? {})
    .flat()
    .map((entry) => tabFilePath(entry.tab));

const finderCtx: FinderBranchContext = {
  windowLabel: WINDOW,
  isCancelled: () => false,
  onOpenFailure: vi.fn(),
  loadFileIntoTab: vi.fn(async () => {}),
};

const openers: Array<[string, () => Promise<unknown>]> = [
  ["Cmd+O (openFileInNewTabCore)", () => openFileInNewTabCore(WINDOW, PNG)],
  ["Finder create branch", () => createNewTabForFile(finderCtx, PNG, null, false)],
];

let stopCleanup: () => void = () => {};

beforeEach(() => {
  rebootstrapFormats();
  // The app frees a removed tab's document through this tab-removal subscriber.
  stopCleanup = startTabStateCleanup();
  useTabStore.getState().removeWindow(WINDOW);
  useDocumentStore.setState({ documents: {} });
  useClosedTabScopesStore.getState().resetClosedScopes();
});

afterEach(() => {
  stopCleanup();
  vi.restoreAllMocks();
});

describe.each(openers)("%s — a media open whose later step throws", (_name, open) => {
  it("removes the tab it created, leaves no document, and rethrows", async () => {
    const keep = useTabStore.getState().createTab(WINDOW, "/w/notes.md");
    vi.spyOn(useRecentFilesStore.getState(), "addFile").mockImplementation(() => {
      throw failure;
    });

    await expect(open()).rejects.toBe(failure);

    expect(tabIds()).toEqual([keep]);
    expect(useTabStore.getState().findTabByPath(WINDOW, PNG)).toBeNull();
    const orphan = Object.values(useDocumentStore.getState().documents).find((d) => d.filePath === PNG);
    expect(orphan).toBeUndefined();
  });

  it("does not file the rolled-back tab under recently closed", async () => {
    vi.spyOn(useRecentFilesStore.getState(), "addFile").mockImplementation(() => {
      throw failure;
    });

    await expect(open()).rejects.toBe(failure);

    expect(closedPaths()).not.toContain(PNG);
  });

  it("never removes a tab createTab deduplicated onto", async () => {
    const existing = useTabStore.getState().createTab(WINDOW, PNG);
    const addFile = vi.spyOn(useRecentFilesStore.getState(), "addFile").mockImplementation(() => {
      throw failure;
    });

    await open();

    expect(addFile).not.toHaveBeenCalled();
    expect(tabIds()).toEqual([existing]);
  });
});
