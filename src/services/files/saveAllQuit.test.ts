// @vitest-environment node
// WI-RA1B.1 — Save All and Quit saves OPEN TABS, never bare documents: a
// document with no live tab is not written. Driven over the real composition
// (real stores, real save pipeline) with `@tauri-apps/*` behind the stateful fs
// fake, so every claim is about bytes on disk and whether the window closed.
// WI-RA25.2 — the command asks Rust for the save-all quit, and each window
// saves its OWN tabs when asked (another window saves its own); a window that
// cannot save stays open.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
}));
// sonner is the external boundary; the IME-safe wrapper runs real.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { handleSaveAllQuit } from "@/services/files/fileSave";
import { runSaveAllQuitFlow } from "@/services/files/saveAllQuit";
import { statefulFs } from "@/test/statefulFsFake";
import {
  WINDOW,
  ROOT,
  resetTier0,
  openDocInTab,
  newUntitledTab,
  editDoc,
  doc,
} from "@/test/tier0/harness";

const DOC = `${ROOT}/笔记.md`;
const OTHER = `${ROOT}/other.md`;
const ORIGINAL = "# 标题\n\n磁盘上的内容。\n";
const EDITED = "# 标题\n\n改过的内容。\n";
const log = () => {};

/** Which windows closed themselves, in order. */
let closed: string[] = [];
/** The documents as they stood when the last window closed — the teardown
 *  that follows takes them away. */
let documentsAtClose: ReturnType<typeof useDocumentStore.getState>["documents"] = {};

function atClose(tabId: string) {
  const record = documentsAtClose[tabId];
  if (!record) throw new Error(`no document for tab ${tabId} when the window closed`);
  return record;
}

beforeEach(() => {
  resetTier0();
  closed = [];
  documentsAtClose = {};
  // `close_window` closes the window that asks: record which flow got there.
  statefulFs.stubCommand("close_window", () => {
    closed.push("closed");
    documentsAtClose = useDocumentStore.getState().documents;
  });
  vi.mocked(saveDialog).mockReset();
  vi.mocked(openDialog).mockReset();
  vi.mocked(toast.error).mockClear();
});

describe("Save All and Quit — the command", () => {
  it("asks Rust for the save-all quit, which asks every window", async () => {
    const requested: unknown[] = [];
    statefulFs.stubCommand("save_all_and_quit", (args) => {
      requested.push(args);
    });
    const tabId = await openDocInTab(DOC, ORIGINAL);
    editDoc(tabId, EDITED);

    await handleSaveAllQuit();

    expect(requested).toHaveLength(1);
    // Nothing is saved here: each window saves its own when it is asked.
    expect(statefulFs.writesTo(DOC)).toEqual([]);
  });
});

describe("Save All and Quit — what a window saves", () => {
  it("does not write a document that has no tab", async () => {
    statefulFs.seed(DOC, ORIGINAL);
    // A document left behind by a removal that forgot it: dirty, pathed, tabless.
    useDocumentStore.getState().initDocument("ghost", ORIGINAL, DOC);
    useDocumentStore.getState().setEditorContent("ghost", "discarded, must never reach disk\n");

    expect(await runSaveAllQuitFlow(WINDOW, log)).toBe(true);

    expect(statefulFs.read(DOC)).toBe(ORIGINAL);
    expect(statefulFs.writesTo(DOC)).toEqual([]);
    expect(closed).toHaveLength(1);
  });

  it("writes every dirty tab's bytes, leaves clean tabs alone, then closes", async () => {
    const dirty = await openDocInTab(DOC, ORIGINAL);
    await openDocInTab(OTHER, "untouched\n");
    editDoc(dirty, EDITED);

    expect(await runSaveAllQuitFlow(WINDOW, log)).toBe(true);

    expect(statefulFs.read(DOC)).toBe(EDITED);
    expect(statefulFs.writesTo(OTHER)).toEqual([]);
    expect(atClose(dirty).isDirty).toBe(false);
    expect(closed).toHaveLength(1);
  });

  it("saves this window's tabs and leaves another window's to that window", async () => {
    const here = await openDocInTab(DOC, ORIGINAL);
    editDoc(here, EDITED);
    statefulFs.seed(OTHER, "old\n");
    const there = useTabStore.getState().createTab("doc-1", OTHER);
    useDocumentStore.getState().initDocument(there, "old\n", OTHER);
    useDocumentStore.getState().setEditorContent(there, "new\n");

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.read(DOC)).toBe(EDITED);
    expect(statefulFs.writesTo(OTHER)).toEqual([]);

    // That window saves it when the quit asks IT.
    await runSaveAllQuitFlow("doc-1", log);
    expect(statefulFs.read(OTHER)).toBe("new\n");
    expect(closed).toHaveLength(2);
  });

  it("closes at once when no open tab needs saving", async () => {
    await openDocInTab(DOC, ORIGINAL);

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.writesTo(DOC)).toEqual([]);
    expect(closed).toHaveLength(1);
  });

  it("closes at once with no tabs at all", async () => {
    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.writes).toEqual([]);
    expect(closed).toHaveLength(1);
  });

  it("saves a divergent document the user chose to keep, instead of closing over it", async () => {
    const tabId = await openDocInTab(DOC, ORIGINAL);
    // An external writer changed the file; the user kept the local buffer.
    statefulFs.externalWrite(DOC, "# 外部修改\n");
    useDocumentStore.getState().markDivergent(tabId);
    expect(doc(tabId).isDirty).toBe(false);

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.read(DOC)).toBe(ORIGINAL);
    expect(atClose(tabId).isDivergent).toBe(false);
    expect(closed).toHaveLength(1);
  });
});

describe("Save All and Quit — untitled tabs and refusals", () => {
  it("an untitled dirty tab lands at the path the dialog returned, then the window closes", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, "初稿\n");
    const target = `${ROOT}/初稿.md`;
    vi.mocked(saveDialog).mockResolvedValue(target);

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.read(target)).toBe("初稿\n");
    expect(atClose(tabId).filePath).toBe(target);
    expect(closed).toHaveLength(1);
  });

  it("cancelling the Save As dialog keeps the window open and the draft dirty", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, "初稿\n");
    vi.mocked(saveDialog).mockResolvedValue(null);

    expect(await runSaveAllQuitFlow(WINDOW, log)).toBe(false);

    expect(closed).toEqual([]);
    expect(statefulFs.writes).toEqual([]);
    expect(doc(tabId).isDirty).toBe(true);
  });

  it("a failed write keeps the window open", async () => {
    const tabId = await openDocInTab(DOC, ORIGINAL);
    editDoc(tabId, EDITED);
    statefulFs.failWrites(new Error("disk full"));

    expect(await runSaveAllQuitFlow(WINDOW, log)).toBe(false);

    expect(closed).toEqual([]);
    expect(statefulFs.read(DOC)).toBe(ORIGINAL);
    expect(doc(tabId).isDirty).toBe(true);
  });

  it("a failure while reserving batch destinations is reported and keeps the window open", async () => {
    editDoc(newUntitledTab(), "一\n");
    editDoc(newUntitledTab(), "二\n");
    vi.mocked(openDialog).mockResolvedValue(ROOT);
    statefulFs.stubCommand("create_file_exclusive", () => {
      throw new Error("permission denied");
    });

    expect(await runSaveAllQuitFlow(WINDOW, log)).toBe(false);

    expect(closed).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith("Failed to save documents");
  });
});
