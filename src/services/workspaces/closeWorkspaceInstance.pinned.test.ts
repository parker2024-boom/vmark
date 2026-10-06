// @vitest-environment node
// WI-RA20.2 — closing a workspace closes its pinned tabs too. The close
// lifecycle refuses a pinned tab, and the bulk close stops at the first
// refusal, so one pinned tab used to make "Close" on the rail do nothing and
// report it as a cancel. Runs the REAL tab store and close lifecycle; only
// the Tauri boundary is stubbed.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { message } from "@tauri-apps/plugin-dialog";
import { useTabStore, type Tab } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useWorkspaceInstancesStore } from "@/stores/workspaceInstancesStore";
import { closeTabsWithDirtyCheck } from "@/services/tabs/tabOperations";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import { createWorkspaceInstance, createWorkspaceRootIdentity } from "@/utils/workspaceIdentity";
import { closeWorkspaceInstance } from "./closeWorkspaceInstance";
import { resetInstanceOperationLocks } from "./instanceOperationLock";

const WINDOW = "main";

startTabStateCleanup();

function seedInstance(instanceId: string, path: string) {
  const rootResult = createWorkspaceRootIdentity(path);
  const instance = createWorkspaceInstance({
    workspaceInstanceId: instanceId,
    root: rootResult.ok ? rootResult.root : null,
    ownerWindowLabel: WINDOW,
    createdFrom: "open",
  });
  useWorkspaceInstancesStore.setState((state) => ({
    instances: { ...state.instances, [instanceId]: instance },
    windows: {
      ...state.windows,
      [WINDOW]: {
        windowLabel: WINDOW,
        workspaceInstanceIds: [...(state.windows[WINDOW]?.workspaceInstanceIds ?? []), instanceId],
        activeWorkspaceInstanceId: state.windows[WINDOW]?.activeWorkspaceInstanceId ?? instanceId,
      },
    },
  }));
}

function addTab(tabId: string, filePath: string) {
  const tab: Tab = { kind: "document", id: tabId, filePath, title: tabId, isPinned: false, formatId: "markdown" };
  useTabStore.setState((state) => ({
    tabs: { ...state.tabs, [WINDOW]: [...(state.tabs[WINDOW] ?? []), tab] },
    activeTabId: { ...state.activeTabId, [WINDOW]: tabId },
  }));
  useDocumentStore.getState().initDocument(tabId, "saved", filePath);
}

const pin = (tabId: string) => useTabStore.getState().togglePin(WINDOW, tabId);
const makeDirty = (tabId: string, filePath: string) =>
  useDocumentStore.getState().initDocument(tabId, "edited", filePath, { savedContent: "saved" });
const tabs = () => useTabStore.getState().getTabsByWindow(WINDOW);
const openIds = () => tabs().map((tab) => tab.id);
const pinnedIds = () => tabs().filter((tab) => tab.isPinned).map((tab) => tab.id);
const instanceIds = () =>
  useWorkspaceInstancesStore.getState().windows[WINDOW]?.workspaceInstanceIds ?? [];
const close = (instanceId: string) =>
  closeWorkspaceInstance(WINDOW, instanceId, { closeTabs: closeTabsWithDirtyCheck });

beforeEach(() => {
  resetInstanceOperationLocks();
  useWorkspaceInstancesStore.setState({ instances: {}, windows: {} });
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  const docs = useDocumentStore.getState();
  Object.keys(docs.documents).forEach((id) => docs.removeDocument(id));
  vi.clearAllMocks();
  invoke.mockReset().mockResolvedValue(undefined);
});

describe("closeWorkspaceInstance with pinned tabs", () => {
  it("closes the workspace when one of its tabs is pinned", async () => {
    seedInstance("wsi-a", "/tmp/alpha");
    addTab("a1", "/tmp/alpha/one.md");
    addTab("a2", "/tmp/alpha/two.md");
    pin("a1");

    expect(await close("wsi-a")).toEqual({ ok: true });
    expect(openIds()).toEqual([]);
    expect(instanceIds()).not.toContain("wsi-a");
  });

  it("closes the workspace when every tab is pinned", async () => {
    seedInstance("wsi-a", "/tmp/alpha");
    addTab("a1", "/tmp/alpha/one.md");
    addTab("a2", "/tmp/alpha/two.md");
    pin("a1");
    pin("a2");

    expect(await close("wsi-a")).toEqual({ ok: true });
    expect(openIds()).toEqual([]);
  });

  it("leaves another workspace's pinned tab pinned and open", async () => {
    seedInstance("wsi-a", "/tmp/alpha");
    seedInstance("wsi-b", "/tmp/beta");
    addTab("a1", "/tmp/alpha/one.md");
    addTab("b1", "/tmp/beta/one.md");
    pin("a1");
    pin("b1");

    expect(await close("wsi-a")).toEqual({ ok: true });
    expect(openIds()).toEqual(["b1"]);
    expect(pinnedIds()).toEqual(["b1"]);
  });

  it("restores every pin, in order, when the first pinned close is cancelled", async () => {
    seedInstance("wsi-a", "/tmp/alpha");
    addTab("a1", "/tmp/alpha/one.md");
    addTab("a2", "/tmp/alpha/two.md");
    addTab("a3", "/tmp/alpha/three.md");
    pin("a1");
    pin("a2");
    // Unpinned tabs close first, then pinned ones right to left: a2 is the
    // first pinned tab asked, and cancelling it stops the rest.
    makeDirty("a2", "/tmp/alpha/two.md");
    vi.mocked(message).mockResolvedValueOnce("Cancel");

    expect(await close("wsi-a")).toEqual({ ok: false, reason: "cancelled" });
    expect(openIds()).toEqual(["a1", "a2"]);
    expect(pinnedIds()).toEqual(["a1", "a2"]);
    expect(instanceIds()).toContain("wsi-a");
  });

  it("keeps the pin on a tab whose save prompt is cancelled after others closed", async () => {
    seedInstance("wsi-a", "/tmp/alpha");
    addTab("a1", "/tmp/alpha/one.md");
    addTab("a2", "/tmp/alpha/two.md");
    addTab("a3", "/tmp/alpha/three.md");
    pin("a1");
    pin("a2");
    makeDirty("a1", "/tmp/alpha/one.md");
    vi.mocked(message).mockResolvedValueOnce("Cancel");

    expect(await close("wsi-a")).toEqual({ ok: false, reason: "cancelled" });
    expect(openIds()).toEqual(["a1"]);
    expect(pinnedIds()).toEqual(["a1"]);
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("stops before any pinned tab when an unpinned tab's prompt is cancelled", async () => {
    seedInstance("wsi-a", "/tmp/alpha");
    addTab("a1", "/tmp/alpha/one.md");
    addTab("a2", "/tmp/alpha/two.md");
    pin("a1");
    makeDirty("a2", "/tmp/alpha/two.md");
    vi.mocked(message).mockResolvedValueOnce("Cancel");

    expect(await close("wsi-a")).toEqual({ ok: false, reason: "cancelled" });
    expect(openIds()).toEqual(["a1", "a2"]);
    expect(pinnedIds()).toEqual(["a1"]);
  });
});
