// @vitest-environment node
// WI-RA11.1 — the watcher addresses `fs:changed` to the owning window, so the
// scan trigger must listen ON that window (a listener without a target is
// woken by every window's watcher), and must read the batched payload.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown) => void;

const bridge = vi.hoisted(() => ({
  windowHandlers: [] as { event: string; handler: Handler }[],
  globalListen: vi.fn(async () => () => {}),
  invoke: vi.fn(async () => ({})),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: async (event: string, handler: Handler) => {
      bridge.windowHandlers.push({ event, handler });
      return bridge.unlisten;
    },
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.globalListen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));

import { startCoherenceScanOnChange } from "./scanOnChange";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const ROOT = "/ws/story";

function batch(rootPath: string, rescan = false) {
  return {
    payload: {
      watchId: "main",
      rootPath,
      changes: rescan ? [] : [{ kind: "modify", paths: [`${rootPath}/第一章.md`] }],
      rescan,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.windowHandlers.length = 0;
  bridge.globalListen.mockClear();
  bridge.invoke.mockClear();
  bridge.unlisten.mockClear();
  useWorkspaceStore.setState({ rootPath: ROOT });
  useSettingsStore.getState().updateGeneralSetting("coherenceCaptureOnSave", false);
});

describe("startCoherenceScanOnChange — default wiring", () => {
  it("listens for fs:changed on the current window, not app-wide", async () => {
    const stop = startCoherenceScanOnChange();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.windowHandlers.map((h) => h.event)).toEqual(["fs:changed"]);
    expect(bridge.globalListen).not.toHaveBeenCalled();
    stop();
    expect(bridge.unlisten).toHaveBeenCalledTimes(1);
  });

  it("scans once after a batch for this window's workspace", async () => {
    startCoherenceScanOnChange();
    await vi.advanceTimersByTimeAsync(0);

    bridge.windowHandlers[0].handler(batch(ROOT));
    await vi.advanceTimersByTimeAsync(3100);

    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    expect(bridge.invoke).toHaveBeenCalledWith("coherence_scan", {
      workspaceRoot: ROOT,
      policy: "tracked-only",
    });
  });

  it("scans after a rescan batch that carries no changes", async () => {
    // The watcher lost track of the tree: exactly the case a reconciliation
    // pass exists for.
    startCoherenceScanOnChange();
    await vi.advanceTimersByTimeAsync(0);

    bridge.windowHandlers[0].handler(batch(ROOT, true));
    await vi.advanceTimersByTimeAsync(3100);

    expect(bridge.invoke).toHaveBeenCalledTimes(1);
  });

  it("ignores a batch for a root that is not this window's workspace", async () => {
    startCoherenceScanOnChange();
    await vi.advanceTimersByTimeAsync(0);

    bridge.windowHandlers[0].handler(batch("/ws/other"));
    await vi.advanceTimersByTimeAsync(3100);

    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});
