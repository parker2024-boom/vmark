// @vitest-environment node
// WI-RA1B.1 — every production path that removes a tab, driven through the REAL
// flow that does the removing (real stores, real services, `@tauri-apps/*` behind
// the stateful fs fake), leaves no document behind. The sites are the ones that
// used to remove a tab and forget its state: the MCP `workspace.close` handler,
// the move-to-new-workspace-window tail, the four open rollbacks, the two
// workspace-restore closes and the hot-exit restore rollback. A discarded
// document that is gone cannot be written by Save All and Quit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
}));

import { useTabStore, tabFilePath } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import { handleWorkspaceClose } from "@/services/mcpBridge/v2/workspace";
import { moveTabToNewWorkspaceWindow } from "@/services/files/fileSave";
import { runSaveAllQuitFlow } from "@/services/files/saveAllQuit";
import { openFileInNewTabCore } from "@/services/navigation/fileOpen";
import { createNewTabForFile } from "@/services/navigation/finderOpenBranches";
import { loadFileIntoTab } from "@/services/navigation/loadFileIntoTab";
import { openLocalFileInTab } from "@/services/navigation/openWorkflowTarget";
import { restoreWorkspaceTabs } from "@/services/navigation/restoreWorkspaceTabs";
import { restoreTabs } from "@/services/persistence/hotExit/restoreHelpers";
import type { TabState, WindowState } from "@/services/persistence/hotExit/types";
import { moveTabToNewWindow } from "@/services/tabs/moveTabToNewWindow";
import {
  restoreTransferredTab,
  transferTabFromDragOut,
} from "@/components/StatusBar/tabTransferActions";
import { applyTabTransferData, handleTabRemovalRequest } from "@/contexts/tabTransferHandlers";
import type { TabRemovalAck, TabTransferPayload } from "@/types/tabTransfer";
import { statefulFs } from "@/test/statefulFsFake";
import { WINDOW, ROOT, resetTier0, openDocInTab, newUntitledTab, editDoc } from "@/test/tier0/harness";

const DOC = `${ROOT}/笔记.md`;
const OTHER = `${ROOT}/other.md`;
const ORIGINAL = "# 标题\n\n磁盘上的内容。\n";
const DISCARDED = "# 标题\n\nAI 决定丢弃的内容。\n";
const EDITED = "# 标题\n\n尚未保存的修改。\n";
/** A second window, standing in for the destination of a transfer. */
const DESTINATION = "doc-2";

function liveTabIds(): Set<string> {
  return new Set(
    Object.values(useTabStore.getState().tabs).flatMap((tabs) => tabs.map((t) => t.id)),
  );
}

/** Document ids with no live tab. */
function orphanDocumentIds(): string[] {
  const live = liveTabIds();
  return Object.keys(useDocumentStore.getState().documents).filter((id) => !live.has(id));
}

function tabForPath(path: string) {
  return useTabStore.getState().getTabsByWindow(WINDOW).find((t) => tabFilePath(t) === path);
}

/**
 * Make the NEXT document-store write fail AFTER it has committed — the shape of
 * a real post-create failure (a subscriber, or a step after the ingest,
 * throwing). The document exists by then, which is exactly the state a rollback
 * that only removes the tab leaves behind.
 */
function failAfterNextDocumentWrite(): void {
  const unsubscribe = useDocumentStore.subscribe(() => {
    unsubscribe();
    throw new Error("injected: failure after the document was created");
  });
}

let stopCleanup: () => void;
/** How often the window closed itself (the end of its part in a quit). */
let closes = 0;
const replies: Array<{ success: boolean; data?: unknown }> = [];

beforeEach(() => {
  resetTier0();
  closes = 0;
  replies.length = 0;
  statefulFs.stubCommand("close_window", () => {
    closes += 1;
  });
  statefulFs.stubCommand("mcp_bridge_respond", (args) => {
    replies.push(args.payload as { success: boolean; data?: unknown });
  });
  stopCleanup = startTabStateCleanup();
});

afterEach(() => {
  stopCleanup();
});

describe("MCP workspace.close", () => {
  it("leaves no document behind", async () => {
    const tabId = await openDocInTab(DOC, ORIGINAL);
    await openDocInTab(OTHER, "kept\n");
    editDoc(tabId, DISCARDED);

    await handleWorkspaceClose("req-1", { tabId, force: true });

    expect(replies.at(-1)).toMatchObject({ success: true, data: { closed: true } });
    expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("Save All and Quit does not write the buffer the AI discarded", async () => {
    const tabId = await openDocInTab(DOC, ORIGINAL);
    await openDocInTab(OTHER, "kept\n");
    editDoc(tabId, DISCARDED);
    await handleWorkspaceClose("req-1", { tabId, force: true });

    await runSaveAllQuitFlow(WINDOW, () => {});

    // The file, not the call: those edits were discarded, so disk is untouched.
    expect(statefulFs.read(DOC)).toBe(ORIGINAL);
    expect(statefulFs.writesTo(DOC)).toEqual([]);
    expect(closes).toBe(1);
  });
});

describe("removal sites leave no orphan document", () => {
  it("moving a tab to a new workspace window closes it here with its document", async () => {
    const outside = "/elsewhere/外部.md";
    const tabId = await openDocInTab(outside, ORIGINAL);
    await openDocInTab(OTHER, "kept\n");
    statefulFs.stubCommand("open_workspace_in_new_window", () => undefined);

    await moveTabToNewWorkspaceWindow(WINDOW, tabId, outside);

    expect(useTabStore.getState().findTabById(tabId)).toBeNull();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("a workspace restore that fails after the tab exists rolls the document back too", async () => {
    statefulFs.seed(DOC, ORIGINAL);
    failAfterNextDocumentWrite();

    const created = await restoreWorkspaceTabs(WINDOW, [DOC]);

    expect(created).toBe(0);
    expect(tabForPath(DOC)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("a workspace restore drops the startup blank tab together with its document", async () => {
    const blank = newUntitledTab();
    statefulFs.seed(DOC, ORIGINAL);

    const created = await restoreWorkspaceTabs(WINDOW, [DOC]);

    expect(created).toBe(1);
    expect(useTabStore.getState().findTabById(blank)).toBeNull();
    expect(useDocumentStore.getState().getDocument(blank)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("a file open that fails after the tab exists rolls the document back too", async () => {
    statefulFs.seed(DOC, ORIGINAL);
    failAfterNextDocumentWrite();

    const outcome = await openFileInNewTabCore(WINDOW, DOC);

    expect(outcome).toBe("failed");
    expect(tabForPath(DOC)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("a Finder open that fails after the tab exists rolls the document back too", async () => {
    statefulFs.seed(DOC, ORIGINAL);
    const failures: unknown[] = [];
    failAfterNextDocumentWrite();

    const landed = await createNewTabForFile(
      {
        windowLabel: WINDOW,
        isCancelled: () => false,
        onOpenFailure: (error) => failures.push(error),
        loadFileIntoTab,
      },
      DOC,
      null,
      false,
    );

    expect(landed).toBeNull();
    expect(failures).toHaveLength(1);
    expect(tabForPath(DOC)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("a workflow-target open that fails after the tab exists rolls the document back too", async () => {
    statefulFs.seed(DOC, ORIGINAL);
    failAfterNextDocumentWrite();

    const result = await openLocalFileInTab(WINDOW, DOC);

    expect(result).toEqual({ ok: false, reason: "load-failed" });
    expect(tabForPath(DOC)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("a hot-exit tab whose payload is corrupt past the ingest is dropped with its document", async () => {
    const sound: TabState = {
      id: "session-a",
      file_path: OTHER,
      title: "other.md",
      is_pinned: false,
      format_id: "markdown",
      editing_enabled: true,
      active_schema_id: null,
      document: {
        content: "kept\n",
        saved_content: "kept\n",
        is_dirty: false,
        is_missing: false,
        is_divergent: false,
        line_ending: "\n",
        cursor_info: null,
        last_modified_timestamp: null,
        is_untitled: false,
        untitled_number: null,
        undo_history: [],
        redo_history: [],
      },
    };
    // Dirty with a non-string body: the ingest of `saved_content` succeeds and
    // creates the document, then applying the dirty buffer throws.
    const corrupt: TabState = {
      ...sound,
      id: "session-b",
      file_path: DOC,
      title: "笔记.md",
      document: {
        ...sound.document,
        saved_content: ORIGINAL,
        is_dirty: true,
        content: null as unknown as string,
      },
    };
    const windowState = {
      window_label: WINDOW,
      is_main_window: true,
      active_tab_id: "session-a",
      tabs: [sound, corrupt],
      ui_state: {},
      geometry: null,
    } as unknown as WindowState;

    const restored = await restoreTabs(WINDOW, windowState);

    expect([...restored.keys()]).toEqual(["session-a"]);
    expect(tabForPath(DOC)).toBeUndefined();
    expect(tabForPath(OTHER)).toBeDefined();
    expect(orphanDocumentIds()).toEqual([]);
  });
});

describe("a transferred tab keeps its document", () => {
  beforeEach(() => {
    // The destination opens the tab's workspace; there is no config on this disk.
    statefulFs.stubCommand("read_workspace_config", () => null);
    statefulFs.stubCommand("close_window", () => undefined);
  });

  it("move to a new window hands over the live buffer, then this window forgets its copy", async () => {
    const tabId = await openDocInTab(DOC, ORIGINAL);
    await openDocInTab(OTHER, "kept\n");
    editDoc(tabId, EDITED);
    const handedOver: TabTransferPayload[] = [];
    statefulFs.stubCommand("detach_tab_to_new_window", (args) => {
      handedOver.push(args.data as TabTransferPayload);
      return DESTINATION;
    });
    const tab = useTabStore.getState().findTabById(tabId);
    if (!tab || tab.kind !== "document") throw new Error("expected a document tab");

    await moveTabToNewWindow({
      tab,
      doc: useDocumentStore.getState().getDocument(tabId),
      filePath: tab.filePath,
      tabs: useTabStore.getState().getTabsByWindow(WINDOW),
      windowLabel: WINDOW,
      workspaceRoot: ROOT,
      restoreTransferredTab: () => Promise.resolve(),
    });

    expect(handedOver).toHaveLength(1);
    expect(handedOver[0]).toMatchObject({ tabId, content: EDITED, savedContent: ORIGINAL, isDirty: true });
    expect(useTabStore.getState().getTabsByWindow(WINDOW).some((t) => t.id === tabId)).toBe(false);
    expect(orphanDocumentIds()).toEqual([]);

    // The destination applies exactly what it was handed: nothing was lost.
    await applyTabTransferData(DESTINATION, handedOver[0]);
    const moved = useDocumentStore.getState().getDocument(tabId);
    expect(moved?.content).toBe(EDITED);
    expect(moved?.isDirty).toBe(true);
  });

  it("drag-out to another window does the same", async () => {
    const tabId = await openDocInTab(DOC, ORIGINAL);
    await openDocInTab(OTHER, "kept\n");
    editDoc(tabId, EDITED);
    const handedOver: TabTransferPayload[] = [];
    statefulFs.stubCommand("find_drop_target_window", () => DESTINATION);
    statefulFs.stubCommand("transfer_tab_to_existing_window", (args) => {
      handedOver.push(args.data as TabTransferPayload);
    });

    await transferTabFromDragOut({
      tabId,
      point: { clientX: -5, clientY: 10, screenX: 900, screenY: 40 },
      windowLabel: WINDOW,
      triggerSnapback: () => {},
      announce: () => {},
    });

    expect(handedOver[0]).toMatchObject({ tabId, content: EDITED, isDirty: true });
    expect(useTabStore.getState().getTabsByWindow(WINDOW).some((t) => t.id === tabId)).toBe(false);
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("undo restores the destination's live edits, and the destination's release does not take them", async () => {
    // The destination holds the tab with edits made after the move.
    const live: TabTransferPayload = {
      tabId: "tab-moved",
      title: "笔记.md",
      filePath: DOC,
      content: "typed in the destination window\n",
      savedContent: ORIGINAL,
      isDirty: true,
      workspaceRoot: null,
    };
    await applyTabTransferData(DESTINATION, live);
    statefulFs.stubCommand("remove_tab_from_window", async (args) => {
      const phase = args.phase as "prepare" | "commit";
      if (phase === "prepare") {
        const ack: TabRemovalAck = {
          requestId: "r1",
          tabId: live.tabId,
          phase,
          accepted: true,
          data: live,
        };
        return ack;
      }
      // commit — the destination drops its copy, as its own handler does.
      await handleTabRemovalRequest(DESTINATION, { requestId: "r1", tabId: live.tabId, phase });
      return undefined;
    });

    await restoreTransferredTab(WINDOW, DESTINATION, { ...live, content: ORIGINAL, isDirty: false });

    expect(useTabStore.getState().getTabsByWindow(DESTINATION)).toEqual([]);
    expect(useTabStore.getState().getTabsByWindow(WINDOW).map((t) => t.id)).toEqual([live.tabId]);
    const restored = useDocumentStore.getState().getDocument(live.tabId);
    expect(restored?.content).toBe("typed in the destination window\n");
    expect(restored?.isDirty).toBe(true);
    expect(orphanDocumentIds()).toEqual([]);
  });
});
