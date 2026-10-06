// @vitest-environment node
/**
 * Hot-exit restore waits for each restored workspace's grant (audit F2 #38/#39).
 *
 * Launch re-grants the recorded roots within a bounded wait, and a root on a
 * slow mount is granted late. The restore activates each window's workspaces
 * and their file trees read at once, so it now asks Rust for every restored
 * root's grant and waits for the answers first — up to a bound, because a DEAD
 * mount can hold `canonicalize` for minutes and a restore must not stall that
 * long. The grant is a deferred `invoke`, held pending to show the wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every other command: `hot_exit_window_restore_complete` answers "all
 *  done", which also releases the module's once-only restore guard. */
const otherCommands = (cmd: string): Promise<unknown> =>
  Promise.resolve(cmd === "hot_exit_window_restore_complete");

const { mockInvoke, mockPull } = vi.hoisted(() => ({
  mockInvoke: vi.fn((_cmd: string, _args?: unknown): Promise<unknown> => Promise.resolve(true)),
  mockPull: vi.fn((_label: string): Promise<unknown> => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("../hotExit/restoreHelpers", () => ({
  MAX_STATE_RETRIES: 5,
  pullWindowStateWithRetry: mockPull,
  restoreWindowState: vi.fn(() => Promise.resolve(new Map())),
}));
vi.mock("@/services/workspaces/switchWorkspaceInstance", () => ({
  beginWindowContextRestore: vi.fn(),
  endWindowContextRestore: vi.fn(),
}));
vi.mock("@/services/workspaces/hydrateWorkspaceInstanceContext", () => ({
  hydrateWorkspaceInstanceContext: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/persistence/hotExit/instanceContextState", () => ({
  restoreInstanceContextState: vi.fn(() => Promise.resolve(true)),
}));

import { RESTORED_GRANT_WAIT_MS, restoreMainWindowState } from "./_hotExitRestore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceInstancesStore } from "@/stores/workspaceInstancesStore";

/** The workspaces the restore has put on the main window's rail (real store). */
const restoredInstances = () => useWorkspaceInstancesStore.getState().windows.main?.workspaceInstanceIds ?? [];

const SLOW = "/Volumes/slow/proj";

function stateWithRoots(...roots: (string | null)[]) {
  return {
    window_label: "main",
    is_main_window: true,
    active_tab_id: null,
    tabs: [],
    ui_state: {},
    geometry: null,
    workspace_instances: roots.map((rootPath, i) => ({
      workspaceInstanceId: `w${i}`,
      kind: rootPath ? "workspace" : "loose",
      rootId: rootPath ? `path:macos:${rootPath}` : null,
      rootPath,
      displayName: rootPath ?? "Loose Files",
      ownerWindowLabel: "main",
      createdFrom: "restore",
      activeTabId: null,
      tabIds: [],
      closedTabIds: [],
    })),
  };
}

/** Hold `allow_workspace_access` pending until `release()`. */
function holdTheGrant(): () => void {
  let release!: () => void;
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "allow_workspace_access"
      ? new Promise((resolve) => {
          release = () => resolve(SLOW);
        })
      : otherCommands(cmd),
  );
  return () => release();
}

const asked = () =>
  mockInvoke.mock.calls.filter(([cmd]) => cmd === "allow_workspace_access").map(([, a]) => a);

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockImplementation(otherCommands);
  useSettingsStore.getState().updateGeneralSetting("workspaceRailMode", true);
  useWorkspaceInstancesStore.setState({ instances: {}, windows: {} });
});

afterEach(() => {
  vi.useRealTimers();
  useSettingsStore.getState().updateGeneralSetting("workspaceRailMode", false);
});

describe("hot-exit restore waits for restored workspaces' grants (#38)", () => {
  it("does not activate a restored workspace until its grant lands", async () => {
    mockPull.mockResolvedValue(stateWithRoots(SLOW, null));
    const release = holdTheGrant();

    const restoring = restoreMainWindowState();
    await vi.waitFor(() => expect(asked()).toEqual([{ path: SLOW }]));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(restoredInstances()).toEqual([]);

    release();
    await restoring;

    expect(restoredInstances()).toEqual(["w0", "w1"]);
  });

  it("waits a bounded time: a dead mount does not stall the restore", async () => {
    vi.useFakeTimers();
    mockPull.mockResolvedValue(stateWithRoots(SLOW));
    holdTheGrant(); // never released

    const restoring = restoreMainWindowState();
    await vi.advanceTimersByTimeAsync(RESTORED_GRANT_WAIT_MS - 1);
    expect(restoredInstances()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await restoring;

    expect(restoredInstances()).toEqual(["w0"]);
  });

  it("asks once per distinct root, and not at all when nothing is a workspace", async () => {
    mockPull.mockResolvedValueOnce(stateWithRoots(SLOW, SLOW, "/other", null));
    await restoreMainWindowState();
    expect(asked()).toEqual([{ path: SLOW }, { path: "/other" }]);

    mockInvoke.mockClear();
    mockPull.mockResolvedValueOnce(stateWithRoots(null));
    await restoreMainWindowState();
    expect(asked()).toEqual([]);
  });
});
