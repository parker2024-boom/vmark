// WI-RA1B.1 — the workspace bootstrap's rollback (a restored tab whose ingest
// fails after the tab exists) leaves no document behind. Real stores and the
// real hook over the stateful fs fake; the sibling suite mocks both stores and
// so cannot see an orphan.
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});

import { useTabStore, tabFilePath } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import { statefulFs } from "@/test/statefulFsFake";
import { WINDOW, ROOT, resetTier0 } from "@/test/tier0/harness";
import { useWorkspaceBootstrap } from "./useWorkspaceBootstrap";

const BROKEN = `${ROOT}/坏掉.md`;
const SOUND = `${ROOT}/sound.md`;

function tabForPath(path: string) {
  return useTabStore.getState().getTabsByWindow(WINDOW).find((t) => tabFilePath(t) === path);
}

function orphanDocumentIds(): string[] {
  const live = new Set(
    Object.values(useTabStore.getState().tabs).flatMap((tabs) => tabs.map((t) => t.id)),
  );
  return Object.keys(useDocumentStore.getState().documents).filter((id) => !live.has(id));
}

let stopCleanup: () => void;

beforeEach(() => {
  resetTier0();
  statefulFs.seed(BROKEN, "# 坏掉\n");
  statefulFs.seed(SOUND, "# sound\n");
  statefulFs.stubCommand("read_workspace_config", () => ({
    version: 1,
    excludeFolders: [],
    lastOpenTabs: [BROKEN, SOUND],
    showHiddenFiles: false,
    showAllFiles: false,
  }));
  stopCleanup = startTabStateCleanup();
});

afterEach(() => {
  stopCleanup();
});

describe("useWorkspaceBootstrap — rollback of a tab that failed to initialise", () => {
  it("drops the tab together with the document the failed ingest left behind", async () => {
    // The first document write commits, then fails — a real post-create failure.
    const unsubscribe = useDocumentStore.subscribe(() => {
      unsubscribe();
      throw new Error("injected: failure after the document was created");
    });

    renderHook(() => useWorkspaceBootstrap());

    // The sibling path still restores: one bad tab costs one tab.
    await waitFor(() => expect(tabForPath(SOUND)).toBeDefined());
    expect(useWorkspaceStore.getState().config).not.toBeNull();
    expect(tabForPath(BROKEN)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });
});
