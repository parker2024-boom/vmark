// WI-RA10A.16 — reverting to a version from the History sidebar goes through
// the app's save pipeline: the file keeps its line endings and byte-order mark,
// the write is atomic and ordered against other saves, and the tab that was
// asked for is the one that changes.
/**
 * Real component, real stores, real `saveToPath` pipeline and real history
 * operations; `@tauri-apps/*` is the only mocked boundary, behind the stateful
 * disk fake. The assertions are about the bytes on disk and the document's
 * state, because that is where the defect lived: the revert wrote the snapshot
 * text with plugin-fs `writeTextFile` itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/plugin-fs", async () =>
  (await import("@/services/mcpBridge/v2/__tests__/bridgeWriteGate")).gatedFsModule(),
);
vi.mock("@tauri-apps/api/core", async () =>
  (await import("@/services/mcpBridge/v2/__tests__/bridgeWriteGate")).gatedCoreModule(),
);
vi.mock("@/contexts/WindowContext", () => ({
  useWindowLabel: () => "main",
}));
// The real hash runs on a worker thread and settles in a later turn of the
// event loop. One directory per path is all the code under test asks of it,
// and a hash that settles in order keeps the racing cases deterministic.
vi.mock("@/utils/historyTypes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/historyTypes")>()),
  hashPath: async (documentPath: string) => testHash(documentPath),
}));

import { ask } from "@tauri-apps/plugin-dialog";
import { statefulFs } from "@/test/statefulFsFake";
import { ROOT, WINDOW, doc, editDoc, openDocInTab, resetTier0, settle } from "@/test/tier0/harness";
import { writeGate } from "@/services/mcpBridge/v2/__tests__/bridgeWriteGate";
import { __resetSerializer } from "@/services/persistence/serializeByPath";
import { resetSaveTargetClaims } from "@/services/persistence/saveTargetClaim";
import { saveToPath } from "@/services/persistence/saveToPath";
import { useTabStore } from "@/stores/tabStore";
import { registerWysiwygFlusher } from "@/utils/wysiwygFlush";
import { matchesPendingSave } from "@/utils/pendingSaves";
import { useDocumentStore } from "@/stores/documentStore";
import type { HistoryIndex, Snapshot } from "@/utils/historyTypes";
import { HistoryView } from "./HistoryView";

/** Hoisted with the mock factory that calls it. */
function testHash(documentPath: string): string {
  return `h${documentPath.replace(/[^a-z0-9]/gi, "_")}`;
}

const DOC = `${ROOT}/notes.md`;
const OTHER = `${ROOT}/other.md`;
const HISTORY_BASE = "/Users/test/.config/history";
const BOM = "\u{FEFF}";

/** A CRLF file with a BOM and CJK text. */
const CURRENT_ON_DISK = `${BOM}# 标题\r\n\r\n现在的正文\r\n`;
const CURRENT_IN_EDITOR = "# 标题\n\n现在的正文\n";
/** The version to restore, as the editor holds text: LF-only, BOM-free. */
const OLD_IN_EDITOR = "# 标题\n\n从前的正文\n";
/** The same version in the file's own convention. */
const OLD_ON_DISK = `${BOM}# 标题\r\n\r\n从前的正文\r\n`;

/**
 * The pinned "now": snapshots are stamped and pruned relative to it, so the
 * history and the revert's own safety snapshot see one fixed clock.
 */
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

const historyDir = (documentPath: string) => `${HISTORY_BASE}/${testHash(documentPath)}`;

/** Put a history on the disk: an index and one file per snapshot. */
function seedHistory(
  documentPath: string,
  snapshots: Array<Pick<Snapshot, "id" | "type"> & { content: string }>,
): void {
  const dir = historyDir(documentPath);
  const index: HistoryIndex = {
    documentPath,
    documentName: documentPath.split("/").pop() ?? "",
    pathHash: testHash(documentPath),
    status: "active",
    deletedAt: null,
    snapshots: snapshots.map((s, i) => ({
      id: s.id,
      type: s.type,
      // Oldest first, a minute apart, all recent enough to survive a prune.
      timestamp: NOW - (snapshots.length - i) * 60_000,
      size: s.content.length,
      preview: s.content,
    })),
    settings: { maxSnapshots: 50, maxAgeDays: 7, mergeWindowSeconds: 30, maxFileSizeKB: 0 },
  };
  statefulFs.seed(`${dir}/index.json`, JSON.stringify(index));
  for (const s of snapshots) statefulFs.seed(`${dir}/${s.id}.md`, s.content);
}

function historyOf(documentPath: string): Array<Snapshot & { content: string }> {
  const dir = historyDir(documentPath);
  const index = JSON.parse(statefulFs.read(`${dir}/index.json`)) as HistoryIndex;
  return index.snapshots.map((s) => ({ ...s, content: statefulFs.read(`${dir}/${s.id}.md`) }));
}

/** Click "Revert" on the version listed at `position` (0 is the newest). */
async function clickRevert(position = 0): Promise<void> {
  const buttons = await screen.findAllByRole("button", { name: "Revert to this Version" });
  await userEvent.click(buttons[position]!);
}

const confirmRevert = () => vi.mocked(ask).mockResolvedValueOnce(true);

beforeEach(() => {
  vi.setSystemTime(NOW);
  writeGate.reset();
  resetTier0();
  statefulFs.mkdirp("/Users/test/.config");
  __resetSerializer();
  resetSaveTargetClaims();
  // The pipeline's provenance capture is not what these tests are about; the
  // kernel declines, as it does for a workspace with no ledger.
  statefulFs.stubCommand("coherence_capture", () => null);
  statefulFs.stubCommand("coherence_head", () => null);
  vi.mocked(ask).mockReset();
  vi.mocked(ask).mockResolvedValue(false);
});

afterEach(() => {
  writeGate.reset();
  vi.useRealTimers();
});

describe("reverting keeps the file's own convention", () => {
  it("restores an LF, BOM-free snapshot into a CRLF file with a BOM, keeping both", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    // A safety snapshot from an earlier revert is stored as the editor held it.
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    confirmRevert();
    render(<HistoryView />);

    await clickRevert();

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(statefulFs.read(DOC)).toBe(OLD_ON_DISK);
    const record = doc(tabId);
    expect(record.isDirty).toBe(false);
    expect(record.lineEnding).toBe("crlf");
    expect(record.hasBom).toBe(true);
    expect(record.savedContent).toBe(OLD_IN_EDITOR);
    expect(record.lastDiskContent).toBe(OLD_ON_DISK);
  });

  it("restores a snapshot taken from disk byte for byte", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "manual", content: OLD_ON_DISK }]);
    confirmRevert();
    render(<HistoryView />);

    await clickRevert();

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(statefulFs.read(DOC)).toBe(OLD_ON_DISK);
    expect(doc(tabId).isDirty).toBe(false);
  });

  it("does not bring an old version's CRLF and BOM into a file that has neither", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_IN_EDITOR);
    seedHistory(DOC, [{ id: "old", type: "manual", content: OLD_ON_DISK }]);
    confirmRevert();
    render(<HistoryView />);

    await clickRevert();

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(statefulFs.read(DOC)).toBe(OLD_IN_EDITOR);
    expect(doc(tabId).lineEnding).toBe("lf");
    expect(doc(tabId).hasBom).toBe(false);
  });
});

describe("reverting writes through the save pipeline", () => {
  it("writes the document atomically, once, and never with plugin-fs", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    confirmRevert();
    render(<HistoryView />);

    await clickRevert();

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(statefulFs.writesTo(DOC)).toEqual([
      { path: DOC, content: OLD_ON_DISK, via: "atomic_write_file" },
    ]);
  });

  it("registers the bytes it wrote, so the watcher's echo is not taken for an external change", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    confirmRevert();
    render(<HistoryView />);

    await clickRevert();

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(matchesPendingSave(DOC, OLD_ON_DISK)).toBe(true);
  });

  it("waits for an autosave already writing the file, instead of writing alongside it", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    const autosaved = "# 标题\n\n自动保存的正文\n";
    editDoc(tabId, autosaved);
    confirmRevert();
    render(<HistoryView />);
    await screen.findAllByRole("button", { name: "Revert to this Version" });

    writeGate.hold(DOC);
    const autosave = saveToPath(tabId, DOC, autosaved, "auto");
    await waitFor(() => expect(writeGate.waitingAt(DOC)).toBe(1));

    await clickRevert();
    // The revert has taken its safety snapshot, so it has reached its write.
    await waitFor(() => expect(historyOf(DOC).map((s) => s.type)).toContain("revert"));
    await settle(200);
    // One write in flight: the autosave. The revert's is queued behind it.
    expect(writeGate.waitingAt(DOC)).toBe(1);
    expect(statefulFs.writesTo(DOC)).toEqual([]);

    writeGate.releaseOne(DOC);
    await autosave;
    await waitFor(() => expect(writeGate.waitingAt(DOC)).toBe(1));
    writeGate.releaseOne(DOC);

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(statefulFs.writesTo(DOC).map((w) => w.content)).toEqual([
      `${BOM}# 标题\r\n\r\n自动保存的正文\r\n`,
      OLD_ON_DISK,
    ]);
    expect(statefulFs.read(DOC)).toBe(OLD_ON_DISK);
    expect(doc(tabId).isDirty).toBe(false);
  });

  it("stays honest when an autosave of the old text lands after it", async () => {
    // The autosave is submitted while the revert's write is in flight, so it
    // carries the text from before the revert and is written second.
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    confirmRevert();
    render(<HistoryView />);
    await screen.findAllByRole("button", { name: "Revert to this Version" });

    writeGate.hold(DOC);
    await clickRevert();
    await waitFor(() => expect(writeGate.waitingAt(DOC)).toBe(1));
    const lateAutosave = saveToPath(tabId, DOC, CURRENT_IN_EDITOR, "auto");
    writeGate.open(DOC);
    await lateAutosave;

    // The disk holds the old text again, and the document SAYS so: it shows
    // the restored version and is dirty, so the next save writes it back.
    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(statefulFs.read(DOC)).toBe(CURRENT_ON_DISK);
    expect(doc(tabId).isDirty).toBe(true);

    await saveToPath(tabId, DOC, doc(tabId).content, "auto");
    expect(statefulFs.read(DOC)).toBe(OLD_ON_DISK);
    expect(doc(tabId).isDirty).toBe(false);
  });

  it("records the restored state as a version, after the safety snapshot", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    confirmRevert();
    render(<HistoryView />);

    await clickRevert();

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    await waitFor(() => expect(historyOf(DOC)).toHaveLength(3));
    expect(historyOf(DOC).map((s) => [s.type, s.content])).toEqual([
      ["revert", OLD_IN_EDITOR],
      ["revert", CURRENT_IN_EDITOR],
      ["manual", OLD_ON_DISK],
    ]);
  });
});

describe("reverting acts on the document it was asked about", () => {
  it("snapshots typing the editor has not flushed to the store yet", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    const typed = "# 标题\n\n现在的正文\n还没同步的一行\n";
    registerWysiwygFlusher(tabId, () => {
      useDocumentStore.getState().setEditorContent(tabId, typed, { fromUserEdit: true });
    });
    confirmRevert();
    render(<HistoryView />);

    try {
      await clickRevert();
      await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    } finally {
      registerWysiwygFlusher(tabId, null);
    }

    const safety = historyOf(DOC).find((s) => s.id !== "old" && s.type === "revert");
    expect(safety?.content).toBe(typed);
  });

  it("reverts the tab the click was made in, when another tab is focused during the dialog", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    const otherContent = "# Other\n\nUntouched.\n";
    const otherTab = await openDocInTab(OTHER, otherContent);
    useTabStore.getState().setActiveTab(WINDOW, tabId);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    vi.mocked(ask).mockImplementationOnce(async () => {
      // The user clicks another tab while the confirmation is open.
      useTabStore.getState().setActiveTab(WINDOW, otherTab);
      return true;
    });
    render(<HistoryView />);

    await clickRevert();

    await waitFor(() => expect(doc(tabId).content).toBe(OLD_IN_EDITOR));
    expect(statefulFs.read(DOC)).toBe(OLD_ON_DISK);
    expect(doc(otherTab).content).toBe(otherContent);
    expect(doc(otherTab).filePath).toBe(OTHER);
    expect(statefulFs.read(OTHER)).toBe(otherContent);
    // The safety snapshot holds the reverted document's text, not the other's.
    const safety = historyOf(DOC).find((s) => s.id !== "old" && s.type === "revert");
    expect(safety?.content).toBe(CURRENT_IN_EDITOR);
  });

  it("changes nothing when the confirmation is declined", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    render(<HistoryView />);

    await clickRevert();
    await settle(200);

    expect(doc(tabId).content).toBe(CURRENT_IN_EDITOR);
    expect(statefulFs.read(DOC)).toBe(CURRENT_ON_DISK);
    expect(statefulFs.writesTo(DOC)).toEqual([]);
    expect(historyOf(DOC).map((s) => s.id)).toEqual(["old"]);
  });

  it("leaves the document as it was when the write is refused", async () => {
    const tabId = await openDocInTab(DOC, CURRENT_ON_DISK);
    seedHistory(DOC, [{ id: "old", type: "revert", content: OLD_IN_EDITOR }]);
    statefulFs.stubCommand("atomic_write_file", () => {
      throw new Error("permission denied");
    });
    confirmRevert();
    render(<HistoryView />);

    await clickRevert();
    // The safety snapshot is taken before the write is attempted.
    await waitFor(() => expect(historyOf(DOC)).toHaveLength(2));
    await settle(200);

    expect(doc(tabId).content).toBe(CURRENT_IN_EDITOR);
    expect(doc(tabId).isDirty).toBe(false);
    expect(statefulFs.read(DOC)).toBe(CURRENT_ON_DISK);
  });
});
