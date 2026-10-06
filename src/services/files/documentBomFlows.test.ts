// @vitest-environment node
// WI-RA21.1 — a file's BOM survives every door a document comes through, and
// a file VMark cannot round-trip is refused instead of opened as garbage.
//
// Real stores and services; `@tauri-apps/*` is the only faked boundary (the
// stateful disk). The open → edit → save round trip itself is pinned by the Tier-0
// suites (src/test/tier0/saveFlow, openFlow); this file covers the doors those
// do not: refusal at open, reload, Keep-my-changes, and our own save's echo.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { statefulFs } from "@/test/statefulFsFake";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { openFileInNewTab } from "@/services/navigation/fileOpen";
import { reloadTabFromDisk } from "@/services/persistence/reloadFromDisk";
import { saveToPath } from "@/services/persistence/saveToPath";
import { keepAllLocal } from "@/services/files/fileChangeBatch";
import { readDocumentText } from "@/services/files/readDocumentText";
import { matchesPendingSave } from "@/utils/pendingSaves";
import { ROOT, WINDOW, doc, editDoc, openDocInTab, resetTier0 } from "@/test/tier0/harness";

const DOC = `${ROOT}/notes.md`;
const BOM = "\u{FEFF}";

beforeEach(() => {
  resetTier0();
  toastError.mockClear();
});

describe("a UTF-16 file is refused, not opened as UTF-8", () => {
  // "# 标题\r\n" in UTF-16LE, behind its FF FE mark.
  const UTF16LE = Uint8Array.from([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x07, 0x68, 0x98, 0x98, 0x0d, 0x00, 0x0a, 0x00]);

  it("leaves no tab and no document, tells the user why, and does not touch the file", async () => {
    statefulFs.seedBytes(DOC, UTF16LE);

    await openFileInNewTab(WINDOW, DOC);

    expect(useTabStore.getState().getTabsByWindow(WINDOW)).toEqual([]);
    expect(useDocumentStore.getState().documents).toEqual({});
    expect(toastError).toHaveBeenCalledTimes(1);
    const [, options] = toastError.mock.calls[0] as [string, { description?: string }];
    expect(options.description).toContain("UTF-16LE");
    expect(options.description).toContain(DOC);
    expect([...statefulFs.readBytes(DOC)]).toEqual([...UTF16LE]);
    expect(statefulFs.writesTo(DOC)).toEqual([]);
  });
});

describe("reload adopts the BOM the file has now", () => {
  it("a BOM added on disk is recorded by a reload, and a save keeps it", async () => {
    const tabId = await openDocInTab(DOC, "# 标题\r\n");
    expect(doc(tabId).hasBom).toBe(false);

    statefulFs.externalWrite(DOC, `${BOM}# 标题\r\n改\r\n`);
    await reloadTabFromDisk(tabId, DOC);

    expect(doc(tabId).hasBom).toBe(true);
    expect(doc(tabId).content).toBe("# 标题\n改\n");
    expect(doc(tabId).lastDiskContent).toBe(`${BOM}# 标题\r\n改\r\n`);

    editDoc(tabId, "# 标题\n改\n再改\n");
    await saveToPath(tabId, DOC, doc(tabId).content, "manual");
    expect(statefulFs.read(DOC)).toBe(`${BOM}# 标题\r\n改\r\n再改\r\n`);
  });

  it("a BOM removed on disk is dropped by a reload, and a save does not put it back", async () => {
    const tabId = await openDocInTab(DOC, `${BOM}body\n`);
    expect(doc(tabId).hasBom).toBe(true);

    statefulFs.externalWrite(DOC, "body\n");
    await reloadTabFromDisk(tabId, DOC);
    expect(doc(tabId).hasBom).toBe(false);

    await saveToPath(tabId, DOC, doc(tabId).content, "manual");
    expect(statefulFs.read(DOC)).toBe("body\n");
  });
});

describe("Keep my changes adopts the disk bytes exactly", () => {
  it("records the external rewrite's BOM, so the same bytes do not prompt again", async () => {
    const tabId = await openDocInTab(DOC, "body\n");
    editDoc(tabId, "body\nmine\n");
    statefulFs.externalWrite(DOC, `${BOM}body\ntheirs\n`);

    await keepAllLocal([{ tabId, filePath: DOC }]);

    // The soft-equals guard compares the next watcher read with this snapshot,
    // and that read keeps the BOM — so the snapshot has to as well.
    expect(doc(tabId).lastDiskContent).toBe(await readDocumentText(DOC));
    expect(doc(tabId).lastDiskContent.startsWith(BOM)).toBe(true);
    expect(doc(tabId).hasBom).toBe(true);
    expect(doc(tabId).content).toBe("body\nmine\n");
  });
});

describe("our own save of a BOM'd file is recognised as ours", () => {
  it("the watcher's read of the written file matches the pending save", async () => {
    const tabId = await openDocInTab(DOC, `${BOM}line\r\n`);
    editDoc(tabId, "line\nmore\n");

    await saveToPath(tabId, DOC, doc(tabId).content, "manual");

    // What the watcher reads back must equal what the save registered, or the
    // app prompts the user about a change it made itself.
    expect(statefulFs.read(DOC)).toBe(`${BOM}line\r\nmore\r\n`);
    expect(matchesPendingSave(DOC, await readDocumentText(DOC))).toBe(true);
  });
});
