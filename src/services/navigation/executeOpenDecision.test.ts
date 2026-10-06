// @vitest-environment node
/**
 * A workspace that fails to open must not be silent.
 *
 * `openWorkspaceForNewTab` caught its error, logged it, and returned void —
 * so `handleOpen` could not tell "there was no workspace to open" from "the
 * workspace failed", treated both as success, and opened the file anyway. The
 * file was then claimed under the PREVIOUS workspace's context, contradicting
 * the ordering requirement #946 exists to enforce, with nothing on screen to
 * explain why the sidebar showed the wrong root.
 *
 * The file still opens — the user asked for the file, not the folder — but the
 * fallback is now deliberate and stated.
 *
 * @coordinates-with services/navigation/executeOpenDecision.ts
 * @module services/navigation/executeOpenDecision.test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockInvoke,
  mockReadFile,
  mockAsk,
  mockSetActiveTab,
  mockOpenWorkspaceWithConfig,
  mockToastWarning,
  mockToastError,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockReadFile: vi.fn(),
  mockAsk: vi.fn(),
  mockSetActiveTab: vi.fn(),
  mockOpenWorkspaceWithConfig: vi.fn(),
  mockToastWarning: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: (...a: unknown[]) => mockReadFile(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...a: unknown[]) => mockAsk(...a),
  message: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/ime/imeToast", () => ({
  imeToast: { warning: mockToastWarning, error: mockToastError, errorDetail: mockToastError, info: vi.fn() },
}));
vi.mock("@/i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/services/workspaces/activateTabWithWorkspaceContext", () => ({
  activateTabWithWorkspaceContext: (...a: unknown[]) => mockSetActiveTab(...a),
}));
vi.mock("@/services/workspaces/openWorkspaceWithConfig", () => ({
  openWorkspaceWithConfig: (...a: unknown[]) => mockOpenWorkspaceWithConfig(...a),
}));
vi.mock("@/utils/debug", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/debug")>()),
  fileOpsError: vi.fn(),
}));
vi.mock("@/utils/perfLog", () => ({ perfMark: vi.fn() }));

import { executeOpenDecision } from "./executeOpenDecision";
import { useSettingsStore } from "@/stores/settingsStore";

const openFileInNewTab = vi.fn(async () => {});
const PATH = "/other/doc.md";

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.getState().resetSettings();
  mockOpenWorkspaceWithConfig.mockResolvedValue(undefined);
  mockInvoke.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(new TextEncoder().encode("# doc"));
  mockAsk.mockResolvedValue(false);
});

describe("create_tab with an external workspace", () => {
  const decision = { action: "create_tab", workspaceRoot: "/other" } as never;

  it("opens the workspace BEFORE the file — the ordering #946 requires", async () => {
    const order: string[] = [];
    mockOpenWorkspaceWithConfig.mockImplementation(async () => { order.push("workspace"); });
    openFileInNewTab.mockImplementation(async () => { order.push("file"); });

    await executeOpenDecision("main", PATH, decision, openFileInNewTab);

    expect(order).toEqual(["workspace", "file"]);
  });

  it("warns the user when the workspace could not be opened", async () => {
    mockOpenWorkspaceWithConfig.mockRejectedValue(new Error("EACCES"));

    await executeOpenDecision("main", PATH, decision, openFileInNewTab);

    expect(mockToastWarning).toHaveBeenCalledWith(
      "dialog:toast.openWorkspaceForFileFailed",
      expect.objectContaining({ pin: true }),
    );
  });

  it("still opens the file after a workspace failure", async () => {
    mockOpenWorkspaceWithConfig.mockRejectedValue(new Error("EACCES"));

    await executeOpenDecision("main", PATH, decision, openFileInNewTab);

    expect(openFileInNewTab).toHaveBeenCalledWith("main", PATH);
  });

  it("says nothing when the workspace opened fine", async () => {
    await executeOpenDecision("main", PATH, decision, openFileInNewTab);
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("says nothing when there was no workspace to open", async () => {
    // "No workspace requested" is not a failure, and used to be indistinguishable
    // from one because the helper returned void in both cases.
    await executeOpenDecision(
      "main",
      PATH,
      { action: "create_tab", workspaceRoot: null } as never,
      openFileInNewTab,
    );

    expect(mockOpenWorkspaceWithConfig).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
    expect(openFileInNewTab).toHaveBeenCalled();
  });
});

describe("the other branches still behave", () => {
  it("activate_tab activates ownership-aware (WI-12.2), touching nothing else", async () => {
    await executeOpenDecision(
      "main",
      PATH,
      { action: "activate_tab", tabId: "t7" } as never,
      openFileInNewTab,
    );

    expect(mockSetActiveTab).toHaveBeenCalledWith("main", "t7");
    expect(openFileInNewTab).not.toHaveBeenCalled();
  });

  it("replace_tab surfaces a genuine failure", async () => {
    const readError = new Error("nope");
    mockReadFile.mockRejectedValue(readError);

    await executeOpenDecision(
      "main",
      PATH,
      { action: "replace_tab", tabId: "t1", filePath: PATH, workspaceRoot: null } as never,
      openFileInNewTab,
    );

    expect(mockReadFile).toHaveBeenCalledWith(PATH);
    // An error VMark did not diagnose is the toast's detail line, unchanged.
    expect(mockToastError).toHaveBeenCalledWith("dialog:toast.fileOpenFailed", readError);
  });

  it("replace_tab stays quiet when the user cancelled", async () => {
    // 6 MB is the "huge" tier: the open asks first, the user declines, and the
    // replace is cancelled before anything is read.
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === "get_file_size_bytes" ? 6 * 1024 * 1024 : undefined,
    );

    await executeOpenDecision(
      "main",
      PATH,
      { action: "replace_tab", tabId: "t1", filePath: PATH, workspaceRoot: null } as never,
      openFileInNewTab,
    );

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("open_workspace_in_new_window reports an invoke failure", async () => {
    mockInvoke.mockRejectedValue(new Error("spawn failed"));

    await executeOpenDecision(
      "main",
      PATH,
      { action: "open_workspace_in_new_window", workspaceRoot: "/w", filePath: PATH } as never,
      openFileInNewTab,
    );

    expect(mockToastError).toHaveBeenCalledWith("dialog:toast.openWorkspaceInNewWindowFailed");
  });

  it("no_op does nothing at all", async () => {
    await executeOpenDecision("main", PATH, { action: "no_op" } as never, openFileInNewTab);

    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(openFileInNewTab).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
