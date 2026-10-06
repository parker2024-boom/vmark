// @vitest-environment node
// WI-RA10A.16 — how a restore ends: what it reports, and what it leaves on
// disk and in the document, for each way it can stop short.
/**
 * Real stores, real `saveToPath` pipeline and real history operations over the
 * stateful disk fake. The History sidebar's own suite covers the path a user
 * takes; this one covers the outcomes that path cannot easily reach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () =>
  (await import("@/services/mcpBridge/v2/__tests__/bridgeWriteGate")).gatedFsModule(),
);
vi.mock("@tauri-apps/api/core", async () =>
  (await import("@/services/mcpBridge/v2/__tests__/bridgeWriteGate")).gatedCoreModule(),
);
// One directory per path is all the code under test asks of a hash, and one
// that settles in order keeps the racing case deterministic.
vi.mock("@/utils/historyTypes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/historyTypes")>()),
  hashPath: async (documentPath: string) => testHash(documentPath),
}));

import { statefulFs } from "@/test/statefulFsFake";
import { ROOT, doc, editDoc, openDocInTab, resetTier0, settle } from "@/test/tier0/harness";
import { writeGate } from "@/services/mcpBridge/v2/__tests__/bridgeWriteGate";
import { __resetSerializer } from "@/services/persistence/serializeByPath";
import { resetSaveTargetClaims } from "@/services/persistence/saveTargetClaim";
import { saveToPath } from "@/services/persistence/saveToPath";
import { imeToast } from "@/services/ime/imeToast";
import type { HistoryIndex, Snapshot } from "@/utils/historyTypes";
import { restoreSnapshotToFile } from "../restoreSnapshot";

/** Hoisted with the mock factory that calls it. */
function testHash(documentPath: string): string {
  return `h${documentPath.replace(/[^a-z0-9]/gi, "_")}`;
}

const DOC = `${ROOT}/notes.md`;
const MOVED = `${ROOT}/moved.md`;
const HISTORY_DIR = `/Users/test/.config/history/${testHash(DOC)}`;

const CURRENT = "# Notes\n\nCurrent text.\n";
const OLD = "# Notes\n\nOld text.\n";

/** The fixed "now" every test runs at; snapshot ages are measured from it. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function seedHistory(snapshots: Array<Pick<Snapshot, "id" | "type"> & { content: string }>): void {
  const index: HistoryIndex = {
    documentPath: DOC,
    documentName: "notes.md",
    pathHash: testHash(DOC),
    status: "active",
    deletedAt: null,
    snapshots: snapshots.map((s, i) => ({
      id: s.id,
      type: s.type,
      timestamp: NOW - (snapshots.length - i) * 60_000,
      size: s.content.length,
      preview: s.content,
    })),
    settings: { maxSnapshots: 50, maxAgeDays: 7, mergeWindowSeconds: 30, maxFileSizeKB: 0 },
  };
  statefulFs.seed(`${HISTORY_DIR}/index.json`, JSON.stringify(index));
  for (const s of snapshots) statefulFs.seed(`${HISTORY_DIR}/${s.id}.md`, s.content);
}

const snapshotTypes = () =>
  (JSON.parse(statefulFs.read(`${HISTORY_DIR}/index.json`)) as HistoryIndex).snapshots.map(
    (s) => s.type,
  );

beforeEach(() => {
  vi.setSystemTime(NOW);
  writeGate.reset();
  resetTier0();
  statefulFs.mkdirp("/Users/test/.config");
  __resetSerializer();
  resetSaveTargetClaims();
  statefulFs.stubCommand("coherence_capture", () => null);
  statefulFs.stubCommand("coherence_head", () => null);
});

afterEach(() => {
  vi.useRealTimers();
  writeGate.reset();
  vi.restoreAllMocks();
});

describe("restoreSnapshotToFile", () => {
  it("reports the exact text it put on disk", async () => {
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);

    const outcome = await restoreSnapshotToFile(tabId, DOC, "old");

    expect(outcome).toEqual({ status: "restored", written: OLD });
    expect(statefulFs.read(DOC)).toBe(OLD);
  });

  it("does not load the document itself: the store still holds the previous text", async () => {
    // Loading is the caller's step. Until it happens the document is the old
    // text, dirty against the version now saved — never clean against it.
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);

    await restoreSnapshotToFile(tabId, DOC, "old");

    expect(doc(tabId).content).toBe(CURRENT);
    expect(doc(tabId).isDirty).toBe(true);
    expect(doc(tabId).savedContent).toBe(OLD);
  });

  it("restores an empty version as an empty file", async () => {
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "blank", type: "manual", content: "" }]);

    const outcome = await restoreSnapshotToFile(tabId, DOC, "blank");

    expect(outcome).toEqual({ status: "restored", written: "" });
    expect(statefulFs.read(DOC)).toBe("");
  });

  it("stops before touching anything when the tab does not hold this file", async () => {
    const tabId = await openDocInTab(MOVED, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);

    const outcome = await restoreSnapshotToFile(tabId, DOC, "old");

    expect(outcome).toEqual({ status: "document-changed" });
    expect(statefulFs.writes).toEqual([]);
    expect(snapshotTypes()).toEqual(["manual"]);
  });

  it("stops before touching anything when the tab is gone", async () => {
    seedHistory([{ id: "old", type: "manual", content: OLD }]);

    const outcome = await restoreSnapshotToFile("closed-tab", DOC, "old");

    expect(outcome).toEqual({ status: "document-changed" });
    expect(statefulFs.writes).toEqual([]);
  });

  it("writes nothing to the document when the version's file is gone", async () => {
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);

    const outcome = await restoreSnapshotToFile(tabId, DOC, "no-such-version");

    expect(outcome).toEqual({ status: "snapshot-missing" });
    expect(statefulFs.writesTo(DOC)).toEqual([]);
    expect(doc(tabId).content).toBe(CURRENT);
    expect(doc(tabId).isDirty).toBe(false);
  });

  it("reports a refused write, tells the user, and leaves the document alone", async () => {
    const toastError = vi.spyOn(imeToast, "errorDetail").mockImplementation(() => "");
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);
    statefulFs.stubCommand("atomic_write_file", () => {
      throw new Error("permission denied");
    });

    const outcome = await restoreSnapshotToFile(tabId, DOC, "old");

    expect(outcome).toEqual({ status: "save-failed" });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(statefulFs.read(DOC)).toBe(CURRENT);
    expect(doc(tabId).content).toBe(CURRENT);
    expect(doc(tabId).isDirty).toBe(false);
    // The text that was about to be replaced is still in the history.
    expect(snapshotTypes()).toEqual(["manual", "revert"]);
  });

  it("rejects, writing nothing to the document, when the safety copy cannot be taken", async () => {
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);
    statefulFs.failWrites(new Error("disk full"));

    await expect(restoreSnapshotToFile(tabId, DOC, "old")).rejects.toThrow("disk full");

    expect(statefulFs.read(DOC)).toBe(CURRENT);
    expect(doc(tabId).content).toBe(CURRENT);
  });

  it("snapshots the text of the tab it was given, edits included", async () => {
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);
    const edited = "# Notes\n\nCurrent text, edited.\n";
    editDoc(tabId, edited);

    await restoreSnapshotToFile(tabId, DOC, "old");

    const index = JSON.parse(statefulFs.read(`${HISTORY_DIR}/index.json`)) as HistoryIndex;
    const safety = index.snapshots.find((s) => s.type === "revert");
    expect(statefulFs.read(`${HISTORY_DIR}/${safety?.id}.md`)).toBe(edited);
  });

  it("reports the document as changed when it is saved under another name mid-restore", async () => {
    const tabId = await openDocInTab(DOC, CURRENT);
    seedHistory([{ id: "old", type: "manual", content: OLD }]);
    writeGate.hold(DOC);

    const restore = restoreSnapshotToFile(tabId, DOC, "old");
    await vi.waitFor(() => expect(writeGate.waitingAt(DOC)).toBe(1));
    // A Save As lands while the restore's write is in flight.
    await saveToPath(tabId, MOVED, CURRENT, "manual");
    writeGate.open(DOC);

    await expect(restore).resolves.toEqual({ status: "document-changed" });
    await settle();
    // The document stayed where the user moved it, with its own text.
    expect(doc(tabId).filePath).toBe(MOVED);
    expect(doc(tabId).content).toBe(CURRENT);
    expect(statefulFs.read(MOVED)).toBe(CURRENT);
  });
});
