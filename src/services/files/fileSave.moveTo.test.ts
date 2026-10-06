// @vitest-environment node
// WI-RA1B.5 — Move To removes the old file on that path's save chain, so a save
// to the old path that was already queued (an autosave still writing) cannot
// land after the removal and recreate the file. Real stores and the real save
// pipeline over the stateful fs fake: the claims are about which files exist.
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

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTabStore, tabFilePath } from "@/stores/tabStore";
import { saveToPath } from "@/services/persistence/saveToPath";
import { isOperationInProgress } from "@/utils/reentryGuard";
import { handleMoveTo } from "@/services/files/fileSave";
import { statefulFs } from "@/test/statefulFsFake";
import { WINDOW, ROOT, resetTier0, openDocInTab, editDoc, doc, settle } from "@/test/tier0/harness";

const OLD = `${ROOT}/旧位置.md`;
const NEW = `${ROOT}/归档/新位置.md`;
const ORIGINAL = "# 标题\n\n原文。\n";
const EDITED = "# 标题\n\n自动保存正在写的内容。\n";

/**
 * Hold every write to `path` until released, then let it land on the fake
 * disk — a save that is in flight, with its bytes not yet on disk.
 */
function holdWritesTo(path: string): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  statefulFs.stubCommand("atomic_write_file", async (args) => {
    const target = String(args.path);
    if (target === path) await gate;
    statefulFs.seed(target, String(args.content));
  });
  return { release };
}

beforeEach(() => {
  resetTier0();
  statefulFs.mkdirp(`${ROOT}/归档`);
  vi.mocked(saveDialog).mockReset();
  vi.mocked(toast.warning).mockClear();
});

describe("Move To — the old file stays gone", () => {
  it("moves the document: new file written, tab re-pointed, old file removed", async () => {
    const tabId = await openDocInTab(OLD, ORIGINAL);
    vi.mocked(saveDialog).mockResolvedValue(NEW);

    await handleMoveTo(WINDOW);

    expect(statefulFs.read(NEW)).toBe(ORIGINAL);
    expect(statefulFs.has(OLD)).toBe(false);
    expect(doc(tabId).filePath).toBe(NEW);
    const tab = useTabStore.getState().findTabById(tabId);
    expect(tab && tabFilePath(tab)).toBe(NEW);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("an autosave queued for the old path before the move does not recreate it", async () => {
    const tabId = await openDocInTab(OLD, ORIGINAL);
    editDoc(tabId, EDITED);
    const oldWrites = holdWritesTo(OLD);
    // The autosave is submitted, and its write is still in flight.
    const autosave = saveToPath(tabId, OLD, EDITED, "auto");
    vi.mocked(saveDialog).mockResolvedValue(NEW);

    const move = handleMoveTo(WINDOW);
    await vi.waitFor(() => expect(statefulFs.has(NEW)).toBe(true));
    await settle();
    // Only now does the autosave's write reach the disk.
    oldWrites.release();
    await Promise.all([autosave, move]);

    expect(statefulFs.has(OLD)).toBe(false);
    expect(statefulFs.read(NEW)).toBe(EDITED);
    expect(doc(tabId).filePath).toBe(NEW);
  });

  it("keeps the old file when a later save kept the document living there", async () => {
    const tabId = await openDocInTab(OLD, ORIGINAL);
    editDoc(tabId, EDITED);
    vi.mocked(saveDialog).mockResolvedValue(NEW);
    // A save to the old path is submitted while the move's own write is in
    // flight: it is the newer save for this document, so the document stays put.
    let superseding: Promise<boolean> | null = null;
    statefulFs.stubCommand("atomic_write_file", (args) => {
      const target = String(args.path);
      if (target === NEW && !superseding) {
        superseding = saveToPath(tabId, OLD, EDITED, "auto");
      }
      statefulFs.seed(target, String(args.content));
    });

    await handleMoveTo(WINDOW);
    await superseding;

    // The document's own file is not deleted out from under it.
    expect(doc(tabId).filePath).toBe(OLD);
    expect(statefulFs.read(OLD)).toBe(EDITED);
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining("couldn't delete original"),
    );
  });

  it("an autosave tick does not start while a move is in progress", async () => {
    await openDocInTab(OLD, ORIGINAL);
    const seen: boolean[] = [];
    vi.mocked(saveDialog).mockImplementation(async () => {
      // What useAutoSave asks before it saves anything.
      seen.push(isOperationInProgress(WINDOW, "save"));
      return NEW;
    });

    await handleMoveTo(WINDOW);

    expect(seen).toEqual([true]);
    expect(isOperationInProgress(WINDOW, "save")).toBe(false);
  });

  it("a second Move To while the first is in progress does nothing", async () => {
    await openDocInTab(OLD, ORIGINAL);
    vi.mocked(saveDialog).mockResolvedValue(NEW);

    await Promise.all([handleMoveTo(WINDOW), handleMoveTo(WINDOW)]);

    expect(vi.mocked(saveDialog)).toHaveBeenCalledTimes(1);
    expect(statefulFs.has(OLD)).toBe(false);
    expect(statefulFs.read(NEW)).toBe(ORIGINAL);
  });

  it("warns, and still completes the move, when the old file cannot be removed", async () => {
    const tabId = await openDocInTab(OLD, ORIGINAL);
    vi.mocked(saveDialog).mockResolvedValue(NEW);
    // An external process deleted the old file first, so the move's own removal fails.
    const fs = statefulFs.fsModule() as { remove: (path: string) => Promise<void> };
    await fs.remove(OLD);

    await handleMoveTo(WINDOW);

    expect(statefulFs.read(NEW)).toBe(ORIGINAL);
    expect(doc(tabId).filePath).toBe(NEW);
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining("couldn't delete original"),
    );
  });
});
