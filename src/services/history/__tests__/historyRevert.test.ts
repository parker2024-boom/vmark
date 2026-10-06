// @vitest-environment node
// WI-RA10A.13 — a revert returns the snapshot it was asked for, including the
// oldest one when the history is at its snapshot limit.
/**
 * Reverting takes a safety snapshot of the current content, and taking a
 * snapshot prunes. At the snapshot limit the prune removes the oldest entry —
 * so when the safety snapshot was taken first, reverting to the oldest version
 * deleted that version and then failed to read it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { HistoryIndex, HistorySettings, Snapshot } from "@/utils/historyTypes";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./historyTestFs")).pluginFsMock);
vi.mock("@tauri-apps/api/path", async () => (await import("./historyTestFs")).pathApiMock);
vi.mock("@/utils/debug", () => ({
  historyLog: vi.fn(),
  historyError: vi.fn(),
}));
// One directory per path is all the code under test asks of a hash.
vi.mock("@/utils/historyTypes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/historyTypes")>()),
  hashPath: async (documentPath: string) => testHash(documentPath),
}));

import { APP_DATA_DIR, vfs } from "./historyTestFs";
import { revertToSnapshot } from "../historyOperations";

/** Hoisted with the mock factory that calls it. */
function testHash(documentPath: string): string {
  return `h${documentPath.replace(/[^a-z0-9]/gi, "_")}`;
}

const DOC = "/work/notes.md";
const DIR = `${APP_DATA_DIR}/history/${testHash(DOC)}`;

const settings: HistorySettings = {
  maxSnapshots: 2,
  maxAgeDays: 7,
  mergeWindowSeconds: 30,
  maxFileSizeKB: 0,
};

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
    settings,
  };
  vfs.seed(`${DIR}/index.json`, JSON.stringify(index));
  for (const s of snapshots) vfs.seed(`${DIR}/${s.id}.md`, s.content);
}

function readIndex(): HistoryIndex {
  return JSON.parse(vfs.read(`${DIR}/index.json`) ?? "null") as HistoryIndex;
}

/** The index and the snapshot files describe each other exactly. */
function expectConsistent(): void {
  const indexed = readIndex().snapshots.map((s) => `${s.id}.md`).sort();
  expect(vfs.filesIn(DIR).filter((name) => name !== "index.json")).toEqual(indexed);
}

const types = () => readIndex().snapshots.map((s) => s.type).sort();

beforeEach(() => {
  vi.setSystemTime(NOW);
  vfs.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("revertToSnapshot", () => {
  it("returns the oldest snapshot even when taking the safety snapshot prunes it", async () => {
    seedHistory([
      { id: "oldest", type: "manual", content: "# Oldest" },
      { id: "newer", type: "manual", content: "# Newer" },
    ]);

    const restored = await revertToSnapshot(DOC, "oldest", "# Current", settings);

    expect(restored).toBe("# Oldest");
    // The limit still holds: the restored version now lives in the document,
    // and the history keeps the two newest entries.
    expect(types()).toEqual(["manual", "revert"]);
    expectConsistent();
  });

  it("returns a snapshot that is nowhere near the limit, as before", async () => {
    seedHistory([{ id: "only", type: "manual", content: "# Only" }]);

    const restored = await revertToSnapshot(DOC, "only", "# Current", settings);

    expect(restored).toBe("# Only");
    expect(types()).toEqual(["manual", "revert"]);
    expectConsistent();
  });

  it("still takes the safety snapshot, and returns null, when the target is gone", async () => {
    seedHistory([{ id: "present", type: "manual", content: "# Present" }]);

    const restored = await revertToSnapshot(DOC, "missing", "# Current", settings);

    expect(restored).toBeNull();
    expect(types()).toEqual(["manual", "revert"]);
    expectConsistent();
  });

  it("takes no snapshot of an unreadable target for a real one", async () => {
    // The target's entry is in the index but its file cannot be read.
    seedHistory([{ id: "broken", type: "manual", content: "# Broken" }]);
    vfs.failNext("readTextFile", "broken.md", new Error("permission denied"));

    const restored = await revertToSnapshot(DOC, "broken", "# Current", settings);

    expect(restored).toBeNull();
  });

  it("rejects, restoring nothing, when the safety snapshot cannot be written", async () => {
    seedHistory([{ id: "target", type: "manual", content: "# Target" }]);
    vfs.failNext("writeTextFile", ".md", new Error("disk full"));

    await expect(revertToSnapshot(DOC, "target", "# Current", settings)).rejects.toThrow(
      "disk full",
    );
  });
});
