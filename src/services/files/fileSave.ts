/**
 * File Save Utilities
 *
 * Purpose: Core save operations — move tab to a new workspace window, and the
 *   Save / Save As / Move To handlers. Save All and Quit lives in
 *   saveAllQuit.ts and is re-exported here for the command binding.
 *
 * @coordinates-with services/windowClose/saveDialog.ts — save path prompt and same-file comparison
 * @coordinates-with services/commands/fileCommands.ts — binds these handlers to menu commands
 * @coordinates-with saveAllQuit.ts — the Save All and Quit handler
 * @coordinates-with services/persistence/serializeByPath.ts — Move To queues the old file's removal on its path's save chain
 * @coordinates-with hooks/useAutoSave.ts — stands down while the "save" guard is held (Save, Save As, Move To)
 * @module services/files/fileSave
 */

import { imeToast as toast } from "@/services/ime/imeToast";
import i18n from "@/i18n";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { remove } from "@tauri-apps/plugin-fs";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { flushActiveWysiwygNow } from "@/utils/wysiwygFlush";
import { withReentryGuard } from "@/utils/reentryGuard";
import { saveToPath } from "@/services/persistence/saveToPath";
import { serializeByPath } from "@/services/persistence/serializeByPath";
import {
  resolvePostSaveWorkspaceAction,
  resolveMissingFileSaveAction,
} from "@/utils/openPolicy";
import { openWorkspaceWithConfig } from "@/services/workspaces/openWorkspaceWithConfig";
import { isWithinRoot, getParentDir, normalizePath } from "@/utils/paths";
import {
  buildDefaultSavePath,
  isSameFilePath,
  promptForSavePath,
} from "@/services/windowClose/saveDialog";
import { fileOpsLog, fileOpsWarn, fileOpsError } from "@/utils/debug";

export { handleSaveAllQuit } from "./saveAllQuit";

/**
 * Move a tab to a new workspace window if the file is outside current workspace.
 * Closes the current tab (or window if it's the last tab).
 * @internal Exported for testing
 */
export async function moveTabToNewWorkspaceWindow(
  windowLabel: string,
  tabId: string,
  filePath: string
): Promise<void> {
  const workspaceRoot = useWorkspaceStore.getState().rootPath;

  // If no workspace or file is within workspace, nothing to do
  if (!workspaceRoot || isWithinRoot(workspaceRoot, filePath)) return;

  // Open in new window - derive workspace from file's parent folder
  // Only close current tab/window if the new window opened successfully
  try {
    await invoke("open_workspace_in_new_window", {
      workspaceRoot: getParentDir(filePath),
      filePath: filePath,
    });
  } catch (error) {
    fileOpsError("Failed to open workspace in new window:", error);
    toast.error(i18n.t("dialog:toast.failedToMoveToNewWindow"));
    return;
  }

  // Re-read AFTER the await: a tab can be opened while the new window is coming
  // up, and closing the window on a stale "last tab" snapshot would take that
  // new tab (and its unsaved content) with it.
  const windowTabs = useTabStore.getState().tabs[windowLabel] || [];
  const isLastTab = windowTabs.length === 1;

  if (isLastTab) {
    const currentWindow = getCurrentWebviewWindow();
    await currentWindow.close();
  } else {
    useTabStore.getState().closeTab(windowLabel, tabId);
  }
}

/**
 * Handle Save (Cmd+S) — save current document, prompting for path if untitled.
 */
export async function handleSave(windowLabel: string): Promise<void> {
  fileOpsLog("handleSave called for window:", windowLabel);
  flushActiveWysiwygNow();

  const guardResult = await withReentryGuard(windowLabel, "save", async () => {
    const tabId = useTabStore.getState().activeTabId[windowLabel];
    if (!tabId) {
      fileOpsWarn("No active tab for save in window:", windowLabel);
      return;
    }

    const doc = useDocumentStore.getState().getDocument(tabId);
    if (!doc) {
      fileOpsWarn("No document found for tab:", tabId);
      return;
    }

    fileOpsLog("Save target:", {
      tabId,
      filePath: doc.filePath ?? "(untitled)",
      isMissing: doc.isMissing,
      isDirty: doc.isDirty,
    });

    // Check missing file policy - block normal save if file was deleted externally
    const saveAction = resolveMissingFileSaveAction({
      isMissing: doc.isMissing,
      hasPath: Boolean(doc.filePath),
    });

    // Track whether file was untitled before save (for auto-workspace logic)
    const hadPathBeforeSave = Boolean(doc.filePath);
    let savedPath: string | null = null;
    let needsSaveAs = saveAction === "save_as_required" || !doc.filePath;

    // Try the normal save path first if we have a file on disk
    if (!needsSaveAs && doc.filePath) {
      const success = await saveToPath(tabId, doc.filePath, doc.content, "manual");
      if (success) {
        savedPath = doc.filePath;
      } else {
        // saveToPath flips isMissing when the parent directory has vanished
        // (renamed/deleted externally). Re-check and fall through to Save As
        // so the user can recover in one click instead of having to retry.
        const refreshed = useDocumentStore.getState().getDocument(tabId);
        if (refreshed?.isMissing) {
          fileOpsLog("Parent directory missing after save attempt — routing to Save As");
          needsSaveAs = true;
        }
      }
    }

    // Save As: untitled, missing-on-open, or parent-missing recovery
    if (needsSaveAs && !savedPath) {
      fileOpsLog("Entering Save As flow (untitled or missing file)");
      const defaultPath = await buildDefaultSavePath(windowLabel, tabId, doc.content, null);
      fileOpsLog("Opening save dialog with defaultPath:", defaultPath);

      const path = await promptForSavePath(defaultPath, "Save");

      if (path) {
        const success = await saveToPath(tabId, path, doc.content, "manual");
        if (success) {
          savedPath = path;
          // Clear missing state — pre-existing or just set during recovery
          const currentDoc = useDocumentStore.getState().getDocument(tabId);
          if (currentDoc?.isMissing) {
            useDocumentStore.getState().clearMissing(tabId);
          }
        }
      }
    }

    // Auto-open workspace after first save of untitled file (if not already in workspace)
    if (savedPath) {
      const { isWorkspaceMode } = useWorkspaceStore.getState();
      const postSaveAction = resolvePostSaveWorkspaceAction({
        isWorkspaceMode,
        hadPathBeforeSave,
        savedFilePath: savedPath,
      });

      if (postSaveAction.action === "open_workspace") {
        try {
          await openWorkspaceWithConfig(postSaveAction.workspaceRoot, { windowLabel });
        } catch (error) {
          fileOpsError("Failed to open workspace after save:", error);
        }
      }
    }
  });
  /* v8 ignore start -- @preserve re-entry guard branch (guardResult === undefined) not exercised in tests */
  if (guardResult === undefined) {
    fileOpsWarn("Save blocked by re-entry guard (another save in progress)");
  }
  /* v8 ignore stop */
}

/**
 * Handle Save As (Cmd+Shift+S) — always prompt for new file path.
 */
export async function handleSaveAs(windowLabel: string): Promise<void> {
  flushActiveWysiwygNow();

  await withReentryGuard(windowLabel, "save", async () => {
    const tabId = useTabStore.getState().activeTabId[windowLabel];
    if (!tabId) return;

    const doc = useDocumentStore.getState().getDocument(tabId);
    if (!doc) return;

    const defaultPath = await buildDefaultSavePath(windowLabel, tabId, doc.content, doc.filePath);

    const path = await promptForSavePath(defaultPath, "Save As");
    if (path) {
      const success = await saveToPath(tabId, path, doc.content, "manual");
      if (!success) return;

      // If saved outside workspace, move to new window
      await moveTabToNewWorkspaceWindow(windowLabel, tabId, path);
    }
  });
}

/**
 * Remove the file a document was moved away from, as a task on that path's
 * save chain, decided when its turn comes.
 *
 * On the chain: a save to the old path submitted before the move (an autosave
 * still writing) would otherwise land AFTER the removal and recreate the file.
 * Queued behind it, the removal runs once that write has settled.
 *
 * Decided at its turn: by then every earlier save to the old path has applied
 * its result. If one of them was submitted after the move's own save, it is the
 * newer save for this document and the document still lives at the old path.
 * Removing the file then would delete the document's own file, which its next
 * autosave would recreate.
 *
 * @returns false when the document still lives at `oldPath` and it was kept.
 */
function removeMovedFromPath(tabId: string, oldPath: string): Promise<boolean> {
  return serializeByPath(normalizePath(oldPath), async () => {
    const livePath = useDocumentStore.getState().getDocument(tabId)?.filePath;
    if (livePath && isSameFilePath(livePath, oldPath)) return false;
    await remove(oldPath);
    return true;
  });
}

/**
 * Handle Move To — save to new location and delete old file.
 *
 * Holds the same guard as Save and Save As: a move re-points the active
 * document, so it must not run alongside either, and auto-save stands down
 * while it is in progress instead of saving to a path that is being left.
 */
export async function handleMoveTo(windowLabel: string): Promise<void> {
  flushActiveWysiwygNow();

  await withReentryGuard(windowLabel, "save", async () => {
    const tabId = useTabStore.getState().activeTabId[windowLabel];
    if (!tabId) return;

    const doc = useDocumentStore.getState().getDocument(tabId);
    if (!doc) return;

    const oldPath = doc.filePath; // null for untitled files
    const defaultPath = await buildDefaultSavePath(windowLabel, tabId, doc.content, oldPath);

    const newPath = await promptForSavePath(defaultPath, "Move To");

    // Moving a file onto itself is a no-op. The destination must be compared as
    // a *file*, not as a string: a case/separator variant of oldPath is the same
    // file on macOS/Windows, and writing it then deleting oldPath below would
    // destroy the document.
    if (!newPath) return;
    if (oldPath && isSameFilePath(oldPath, newPath)) return;

    // Save to new location
    const success = await saveToPath(tabId, newPath, doc.content, "manual");
    if (!success) return;

    // Delete old file (only if there was one)
    if (oldPath) {
      try {
        if (!(await removeMovedFromPath(tabId, oldPath))) {
          // A newer save kept the document at the old path: the new file is a
          // copy and nothing moved, so the tab stays where it is.
          toast.warning(i18n.t("dialog:toast.fileMovedCantDeleteOriginal"));
          return;
        }
      } catch (error) {
        fileOpsError("Failed to delete old file during move:", error);
        // File was saved to new location, but old file couldn't be deleted
        toast.warning(i18n.t("dialog:toast.fileMovedCantDeleteOriginal"));
      }
    }

    // If moved outside workspace, open in new window
    await moveTabToNewWorkspaceWindow(windowLabel, tabId, newPath);
  });
}
