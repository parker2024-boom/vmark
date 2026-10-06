// WI-RA11.1 — a watcher that lost track of the tree (the OS dropped events, or
// the watcher errored) reports `rescan`, and the explorer re-lists. The whole
// frontend pipeline is real here: the Tauri event listener is the only fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type RawHandler = (event: { payload: unknown }) => void;

const bridge = vi.hoisted(() => ({
  handlers: [] as RawHandler[],
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, handler: RawHandler) => {
    bridge.handlers.push(handler);
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onFocusChanged: async () => () => {} }),
}));

import { _resetWorkspaceEventSources } from "@/services/workspaceEvents/subscribeWorkspaceEvents";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { DEFAULT_RESCAN_TIMING } from "./rescanScheduler";
import { useFileTree } from "./useFileTree";

const ROOT = "/root";
const listings = () => bridge.invoke.mock.calls.filter(([cmd]) => cmd === "list_directory_tree");

/** Deliver one raw watcher batch to every registered listener, as Rust would. */
function emitBatch(payload: unknown): void {
  for (const handler of bridge.handlers) handler({ payload });
}

/** Let the bus coalesce and the scheduler's quiet period elapse. */
async function settleScan(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(DEFAULT_RESCAN_TIMING.quietMs);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.handlers.length = 0;
  bridge.invoke.mockReset();
  bridge.invoke.mockResolvedValue({ rootPrefix: `${ROOT}/`, separator: "/", entries: [], truncated: false });
  _resetWorkspaceEventSources();
  useDocumentStore.setState({ documents: {} });
  useTabStore.setState({ tabs: {}, activeTabId: {} });
  useWorkspaceStore.setState({ rootPath: ROOT, config: null, isWorkspaceMode: true });
});

afterEach(() => {
  _resetWorkspaceEventSources();
  vi.useRealTimers();
});

describe("useFileTree — watcher rescan", () => {
  it("re-lists the tree when the watcher reports a rescan with no changes", async () => {
    renderHook(() => useFileTree(ROOT, { watchId: "main" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listings()).toHaveLength(1);

    emitBatch({ watchId: "main", rootPath: ROOT, changes: [], rescan: true });
    await settleScan();

    expect(listings()).toHaveLength(2);
  });

  it("re-lists once for a batch that carries many changes", async () => {
    renderHook(() => useFileTree(ROOT, { watchId: "main" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    emitBatch({
      watchId: "main",
      rootPath: ROOT,
      // Created files: unreadable through the unmocked fs, so never suppressed.
      changes: Array.from({ length: 200 }, (_, i) => ({ kind: "create", paths: [`${ROOT}/n${i}.md`] })),
      rescan: false,
    });
    await settleScan();

    expect(listings()).toHaveLength(2);
  });

  it("does not re-list for another window's rescan", async () => {
    renderHook(() => useFileTree(ROOT, { watchId: "main" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    emitBatch({ watchId: "doc-2", rootPath: ROOT, changes: [], rescan: true });
    await settleScan();

    expect(listings()).toHaveLength(1);
  });

  it("does not re-list for a rescan of a root this window no longer shows", async () => {
    renderHook(() => useFileTree(ROOT, { watchId: "main" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    emitBatch({ watchId: "main", rootPath: "/previous", changes: [], rescan: true });
    await settleScan();

    expect(listings()).toHaveLength(1);
  });
});
