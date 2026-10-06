/**
 * workspaceWindowActions.testUtils — shared mocks and store fixtures for the
 * workspace window action tests: Tauri invoke and listen mocks, rail mode,
 * workspace instances, tabs and transfer acknowledgements.
 *
 * @module services/workspaces/workspaceWindowActions.testUtils
 */

import { vi } from "vitest";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTabStore } from "@/stores/tabStore";
import { useWorkspaceInstancesStore } from "@/stores/workspaceInstancesStore";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import { createWorkspaceInstance, createWorkspaceRootIdentity } from "@/utils/workspaceIdentity";
import type {
  WorkspaceTransferAckPayload,
  WorkspaceTransferPayload,
} from "@/types/workspaceTransfer";

const mocks = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockOpenWorkspaceWithConfig: vi.fn(),
}));

export const mockInvoke = mocks.mockInvoke;
export const mockListen = mocks.mockListen;
export const mockOpenWorkspaceWithConfig = mocks.mockOpenWorkspaceWithConfig;

// The factories read the hoisted `mocks` object, not the exports above: a
// module imported while this file is still loading may reach these APIs first.
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.mockInvoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: mocks.mockListen }),
}));

let stopTabStateCleanup: (() => void) | null = null;

export function resetWorkspaceActionTestState(): void {
  // A window runs the tab-state cleanup for its whole lifetime, and the
  // actions under test rely on it to free the state of a tab they remove.
  stopTabStateCleanup?.();
  stopTabStateCleanup = startTabStateCleanup();
  vi.useRealTimers();
  setLocationSearch("");
  setRailMode(false);
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockOpenWorkspaceWithConfig.mockReset();
  // invoke() always returns a promise in production — default unmatched calls
  // (e.g. close_window) to a resolved promise so `.catch()`/await never sees
  // `undefined`. Specific mockResolvedValueOnce calls still take precedence.
  mockInvoke.mockResolvedValue(undefined);
  mockListen.mockResolvedValue(vi.fn());
  mockOpenWorkspaceWithConfig.mockResolvedValue(null);
  useWorkspaceInstancesStore.getState().resetWorkspaceInstances();
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
  useRevisionStore.setState({ revisions: {} });
}

export function setRailMode(enabled: boolean): void {
  useSettingsStore.setState({
    general: { ...useSettingsStore.getState().general, workspaceRailMode: enabled },
  });
}

export function addInstance(
  windowLabel: string,
  workspaceInstanceId: string,
  rootPath: string,
): void {
  const root = createWorkspaceRootIdentity(rootPath, { platform: "macos" });
  if (!root.ok) throw new Error("test root should be valid");
  useWorkspaceInstancesStore.getState().addWorkspaceInstance(
    createWorkspaceInstance({
      workspaceInstanceId,
      root: root.root,
      ownerWindowLabel: windowLabel,
      createdFrom: "open",
    }),
  );
}

export function addLooseInstance(windowLabel: string, workspaceInstanceId: string): void {
  useWorkspaceInstancesStore.getState().addWorkspaceInstance(
    createWorkspaceInstance({
      workspaceInstanceId,
      root: null,
      ownerWindowLabel: windowLabel,
      createdFrom: "open",
      kind: "loose",
    }),
  );
}

export function addTab(
  windowLabel: string,
  filePath: string | null,
  content: string,
  options: { dirty?: boolean; readOnly?: boolean; missing?: boolean } = {},
): string {
  const tabId = useTabStore.getState().createTab(windowLabel, filePath);
  useDocumentStore.getState().initDocument(tabId, content, filePath, { savedContent: content });
  if (options.dirty) useDocumentStore.getState().setEditorContent(tabId, `${content}\nchanged`);
  if (options.readOnly) useDocumentStore.getState().setReadOnly(tabId, true);
  if (options.missing) useDocumentStore.getState().markMissing(tabId);
  return tabId;
}

export function ackTransfer(payload: WorkspaceTransferPayload, targetWindowLabel = "doc-2"): void {
  const listener = mockListen.mock.calls[0]?.[1] as
    | ((event: { payload: WorkspaceTransferAckPayload }) => void)
    | undefined;
  listener?.({
    payload: {
      requestId: payload.requestId,
      targetWindowLabel,
      workspaceInstanceId: payload.workspaceInstanceId,
    },
  });
}

export function setLocationSearch(search: string): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { search },
  });
}
