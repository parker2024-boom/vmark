// WI-RA7C.7 — a watcher `rescan` re-checks every open document, end to end
// through the real stores. The routing itself is pinned with a fake context in
// `services/windowClose/fsChangeHandlers.test.ts`; this proves the hook wires
// its disk reads and store mutators into that route.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  exists: vi.fn(async () => true),
  toastInfo: vi.fn(),
  subscribeWorkspaceEvents: vi.fn((_label: string, _cb: unknown) => () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-fs", async () => {
  const { fileBytes } = await import("@/test/fileBytes");
  return { readFile: (path: string) => fileBytes(mocks.readTextFile(path)), exists: mocks.exists };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { info: mocks.toastInfo, success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/services/ime/imeToast", () => ({
  imeToast: { info: mocks.toastInfo, success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/contexts/WindowContext", () => ({ useWindowLabel: vi.fn(() => "main") }));
vi.mock("@/utils/pendingSaves", () => ({
  matchesPendingSave: vi.fn(() => false),
  hasPendingSave: vi.fn(() => false),
}));
vi.mock("@/services/persistence/saveToPath", () => ({ saveToPath: vi.fn() }));
vi.mock("@/services/persistence/reloadFromDisk", () => ({ reloadTabFromDisk: vi.fn() }));
vi.mock("@/services/workspaces/activeWorkspaceScope", () => ({
  getActiveWorkspaceScope: vi.fn(() => ({ rootPath: null })),
}));
vi.mock("@/services/workspaceEvents/subscribeWorkspaceEvents", () => ({
  subscribeWorkspaceEvents: mocks.subscribeWorkspaceEvents,
}));

import { useDocumentStore } from "@/stores/documentStore";
import { seedTabAndDocument } from "@/test/externalFileChangesFixtures";
import type { SemanticWorkspaceEvent } from "@/services/workspaceEvents";
import { useExternalFileChanges } from "./useExternalFileChanges";

const RESCAN: SemanticWorkspaceEvent = {
  kind: "rescan",
  path: "/workspace",
  rootPath: "/workspace",
  selfWrite: false,
};

/** Render the hook and hand back the listener it gave the event source. */
async function subscribedListener(): Promise<(events: SemanticWorkspaceEvent[]) => void> {
  renderHook(() => useExternalFileChanges());
  await vi.waitFor(() => expect(mocks.subscribeWorkspaceEvents).toHaveBeenCalled());
  const call = mocks.subscribeWorkspaceEvents.mock.calls.find((c) => typeof c[1] === "function");
  if (!call) throw new Error("the hook did not subscribe");
  return call[1] as (events: SemanticWorkspaceEvent[]) => void;
}

describe("useExternalFileChanges — watcher rescan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exists.mockResolvedValue(true);
  });

  it("reloads a clean open document that changed while the watcher had lost track", async () => {
    seedTabAndDocument({ lastDiskContent: "# old content" });
    mocks.readTextFile.mockResolvedValue("# changed during the burst");
    const deliver = await subscribedListener();

    deliver([RESCAN]);

    await vi.waitFor(() =>
      expect(useDocumentStore.getState().documents["tab-1"]?.content).toBe(
        "# changed during the burst",
      ),
    );
    expect(mocks.readTextFile).toHaveBeenCalledWith("/workspace/test.md");
  });

  it("marks an open document missing when its file was deleted during the burst", async () => {
    seedTabAndDocument({ lastDiskContent: "# old content" });
    mocks.readTextFile.mockRejectedValue(new Error("ENOENT"));
    mocks.exists.mockResolvedValue(false);
    const deliver = await subscribedListener();

    deliver([RESCAN]);

    await vi.waitFor(() =>
      expect(useDocumentStore.getState().documents["tab-1"]?.isMissing).toBe(true),
    );
  });
});
