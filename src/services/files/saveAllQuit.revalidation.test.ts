// @vitest-environment node
// WI-RA1B.4 — Save All and Quit trusts nothing it captured before a dialog, and
// quits only from a pass that found every open document at rest. The save
// dialogs stay open for as long as the user takes; an edit (human or MCP), a
// save through another path, or a tab close can all land in that window. Real
// stores and the real save pipeline over the stateful fs fake: every claim is
// about bytes on disk and whether the window closed for the quit.
// WI-RA25.2 — each window runs this for itself when the quit asks it to save
// everything; a window that closed has torn its documents down, so what it
// saved is read from the disk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { saveToPath } from "@/services/persistence/saveToPath";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
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
const TARGET = `${ROOT}/初稿.md`;
const ELSEWHERE = `${ROOT}/别处.md`;
const V1 = "# 标题\n\n第一版。\n";
const V2 = "# 标题\n\n第二版，对话框开着的时候写的。\n";

let closes = 0;
/** The documents as they stood when the window closed itself — the teardown that
 *  follows takes them away. */
let documentsAtClose: ReturnType<typeof useDocumentStore.getState>["documents"] = {};
const log = () => {};
let stopCleanup: () => void;

/** Contents the app wrote to `path`, in order. */
/** A document as it stood when the window closed. */
function atClose(tabId: string) {
  const record = documentsAtClose[tabId];
  if (!record) throw new Error(`no document for tab ${tabId} when the window closed`);
  return record;
}

function contentsWrittenTo(path: string): string[] {
  return statefulFs.writesTo(path).map((w) => w.content);
}

beforeEach(() => {
  resetTier0();
  closes = 0;
  documentsAtClose = {};
  statefulFs.stubCommand("close_window", () => {
    closes += 1;
    documentsAtClose = useDocumentStore.getState().documents;
  });
  // The exclusive-create the batch reserves destinations with.
  statefulFs.stubCommand("create_file_exclusive", (args) => {
    const path = String(args.path);
    if (statefulFs.has(path)) return false;
    statefulFs.seed(path, "");
    return true;
  });
  vi.mocked(saveDialog).mockReset();
  vi.mocked(openDialog).mockReset();
  vi.mocked(toast.error).mockClear();
  stopCleanup = startTabStateCleanup();
});

afterEach(() => {
  stopCleanup();
});

describe("Save All and Quit — nothing captured before a dialog is trusted after it", () => {
  it("writes the content edited while the Save As dialog was open", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, V1);
    vi.mocked(saveDialog).mockImplementation(async () => {
      editDoc(tabId, V2); // lands while the dialog is open
      return TARGET;
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.read(TARGET)).toBe(V2);
    // The stale capture never reached disk at all.
    expect(contentsWrittenTo(TARGET)).toEqual([V2]);
    expect(atClose(tabId).isDirty).toBe(false);
    expect(closes).toBe(1);
  });

  it("does not rewrite a document that became clean while the dialog was open", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, V1);
    vi.mocked(saveDialog).mockImplementation(async () => {
      // Another path (an MCP save_as, say) saves the document meanwhile.
      editDoc(tabId, V2);
      await saveToPath(tabId, ELSEWHERE, V2, "manual");
      return TARGET;
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.has(TARGET)).toBe(false);
    expect(contentsWrittenTo(ELSEWHERE)).toEqual([V2]);
    expect(atClose(tabId).filePath).toBe(ELSEWHERE);
    expect(closes).toBe(1);
  });

  it("does not write a draft that was emptied again while the dialog was open", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, V1);
    vi.mocked(saveDialog).mockImplementation(async () => {
      editDoc(tabId, ""); // back to the pristine empty draft
      return TARGET;
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.has(TARGET)).toBe(false);
    expect(closes).toBe(1);
  });

  it("does not write a tab that was closed while the dialog was open", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, V1);
    vi.mocked(saveDialog).mockImplementation(async () => {
      useTabStore.getState().closeTab(WINDOW, tabId);
      return TARGET;
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(statefulFs.has(TARGET)).toBe(false);
    expect(statefulFs.writes).toEqual([]);
    expect(closes).toBe(1);
  });

  it("does not write a closed tab even when its document was left behind", async () => {
    // No cleanup running: the closed tab's dirty document stays in the store.
    stopCleanup();
    const tabId = newUntitledTab();
    editDoc(tabId, V1);
    vi.mocked(saveDialog).mockImplementation(async () => {
      useTabStore.getState().closeTab(WINDOW, tabId);
      return TARGET;
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(useDocumentStore.getState().getDocument(tabId)?.isDirty).toBe(true);
    expect(statefulFs.has(TARGET)).toBe(false);
    expect(closes).toBe(1);
  });

  it("with several drafts, one that became clean while the folder picker was open gets no file", async () => {
    const saved = newUntitledTab();
    const kept = newUntitledTab();
    editDoc(saved, "一\n");
    editDoc(kept, "二\n");
    vi.mocked(openDialog).mockImplementation(async () => {
      await saveToPath(saved, ELSEWHERE, "一\n", "manual");
      editDoc(kept, "二，改过\n");
      return ROOT;
    });
    const before = new Set(statefulFs.paths());

    await runSaveAllQuitFlow(WINDOW, log);

    const created = statefulFs.paths().filter((p) => !before.has(p) && p.startsWith(`${ROOT}/`));
    // Exactly the two documents: the one saved elsewhere, and the remaining draft.
    expect(created).toHaveLength(2);
    expect(created).toContain(ELSEWHERE);
    const keptPath = atClose(kept).filePath;
    expect(keptPath).not.toBeNull();
    expect(statefulFs.read(keptPath as string)).toBe("二，改过\n");
    expect(closes).toBe(1);
  });

  it("removes the destination it reserved for a draft that was closed before its turn", async () => {
    const first = newUntitledTab();
    const closedLater = newUntitledTab();
    editDoc(first, "一\n");
    editDoc(closedLater, "二\n");
    vi.mocked(openDialog).mockResolvedValue(ROOT);
    // The tab goes away while the batch is writing the draft before it.
    const unsubscribe = useDocumentStore.subscribe((state) => {
      if (state.documents[first]?.filePath) {
        unsubscribe();
        useTabStore.getState().closeTab(WINDOW, closedLater);
      }
    });
    const before = new Set(statefulFs.paths());

    await runSaveAllQuitFlow(WINDOW, log);

    const created = statefulFs.paths().filter((p) => !before.has(p) && p.startsWith(`${ROOT}/`));
    expect(created).toEqual([atClose(first).filePath]);
    expect(closes).toBe(1);
  });
});

describe("Save All and Quit — quits only from a pass that found everything at rest", () => {
  it("saves again a document edited after its own save, while a later dialog was open", async () => {
    const pathed = await openDocInTab(DOC, "原文\n");
    editDoc(pathed, V1);
    const draft = newUntitledTab();
    editDoc(draft, "初稿\n");
    vi.mocked(saveDialog).mockImplementation(async () => {
      editDoc(pathed, V2); // DOC was already written with V1 by now
      return TARGET;
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(contentsWrittenTo(DOC)).toEqual([V1, V2]);
    expect(statefulFs.read(DOC)).toBe(V2);
    expect(statefulFs.read(TARGET)).toBe("初稿\n");
    expect(atClose(pathed).isDirty).toBe(false);
    expect(closes).toBe(1);
  });

  it("saves an edit that landed during the write itself before quitting", async () => {
    const tabId = await openDocInTab(DOC, "原文\n");
    editDoc(tabId, V1);
    const written: string[] = [];
    statefulFs.stubCommand("atomic_write_file", (args) => {
      const content = String(args.content);
      written.push(content);
      if (written.length === 1) editDoc(tabId, V2); // lands mid-write
      statefulFs.seed(String(args.path), content);
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(written).toEqual([V1, V2]);
    expect(statefulFs.read(DOC)).toBe(V2);
    expect(closes).toBe(1);
  });

  it("refuses to quit, and says so, while a document will not come to rest", async () => {
    const tabId = await openDocInTab(DOC, "原文\n");
    editDoc(tabId, V1);
    let writes = 0;
    statefulFs.stubCommand("atomic_write_file", (args) => {
      writes += 1;
      // A concurrent writer that edits on every save.
      editDoc(tabId, `${String(args.content)}+`);
      statefulFs.seed(String(args.path), String(args.content));
    });

    await runSaveAllQuitFlow(WINDOW, log);

    expect(closes).toBe(0);
    expect(writes).toBe(3); // bounded: three passes, then a refusal
    expect(doc(tabId).isDirty).toBe(true);
    expect(toast.error).toHaveBeenCalledWith("Failed to save documents");
  });
});
