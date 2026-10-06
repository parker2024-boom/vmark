/**
 * Purpose: `vmark.workspace.save_as` handler.
 *
 * Kept separate from `workspace.ts` because save-as carries the bridge's
 * approval, path-boundary and overwrite policy.
 *
 * Key decision: `autoApproveEdits` authorises saving to a NEW location, never
 * destroying an existing one. The allowed roots include the parent directory
 * of every open document, so without that split an auto-approved save_as
 * could silently overwrite any sibling of any open file.
 *
 * Key decision: the write itself is the app's own save (`bridgeSave.ts`). The
 * save pipeline re-points the document and its tab at the new path, and only
 * when this save is still the newest one requested for the document — so an
 * autosave to the old path that lands later cannot pull the tab back, and of
 * two Save As requests the one asked for last wins. It also keeps the
 * document's line endings and byte-order mark, records history, and captures
 * provenance under the capture-on-save setting like every other MCP write.
 *
 * @coordinates-with tabGuard.ts — tab resolution, the flush, INVALID_TAB
 * @coordinates-with bridgeSave.ts — the path guard and the save pipeline
 * @coordinates-with liveEditor.ts — flushes pending keystrokes into the buffer first
 * @coordinates-with services/persistence/applyPostSaveState.ts — re-points the document and tab
 * @module services/mcpBridge/v2/workspaceSaveAs
 */

import { exists } from "@tauri-apps/plugin-fs";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getFileName, normalizePath } from "@/utils/paths";
import { checkBridgePath } from "@/services/mcpBridge/bridgePathGuard";
import { imeToast } from "@/services/ime/imeToast";
import i18n from "@/i18n";
import { respond } from "@/services/mcpBridge/utils";
import { wrapHandler } from "./wrapHandler";
import { respondSaveFailed, saveTabForBridge } from "./bridgeSave";
import { flushLiveEditors } from "./liveEditor";
import { readOperationArgs } from "./readOperationArgs";
import { requireTab, structuredError } from "./tabGuard";

export async function handleWorkspaceSaveAs(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.workspace.save_as", args);
    const filePath = wire.filePath;
    // A value of the wrong type reads as absent; an empty path names nothing.
    if (!filePath) {
      await structuredError(id, {
        error: "INVALID_PATH",
        message: "filePath must be a non-empty string",
      });
      return;
    }

    const decision = await checkBridgePath(filePath);
    if (!decision.allowed) {
      await structuredError(id, {
        error: "INVALID_PATH",
        message: decision.reason,
      });
      return;
    }

    const tab = await requireTab(id, wire.tabId);
    if (!tab) return;
    const { tabId } = tab;

    const autoApprove =
      useSettingsStore.getState().advanced.mcpServer.autoApproveEdits;
    const sameOpenPath =
      tab.filePath != null &&
      normalizePath(tab.filePath) === normalizePath(filePath);
    if (!autoApprove && !sameOpenPath) {
      imeToast.warning(
        i18n.t("dialog:toast.mcpApprovalRequired", {
          filename: getFileName(filePath) || filePath,
        }),
      );
      await structuredError(id, {
        error: "APPROVAL_REQUIRED",
        message:
          "Saving to a new location requires user approval (autoApproveEdits is off)",
      });
      return;
    }

    // `autoApproveEdits` authorises saving to a NEW location — it does
    // not authorise destroying an existing one. The bridge's allowed roots
    // include the parent directory of every open document, so without this an
    // auto-approved save_as could silently overwrite any sibling of any open
    // file. Saving over the tab's own path is a save, not a clobber.
    if (!sameOpenPath && (await exists(filePath))) {
      const name = getFileName(filePath) || filePath;
      imeToast.warning(
        i18n.t("dialog:toast.mcpApprovalRequired", { filename: name }),
      );
      await structuredError(id, {
        error: "APPROVAL_REQUIRED",
        message:
          `Refusing to overwrite the existing file ${name}. ` +
          `save_as will not replace a file that is not the tab's own path. ` +
          `Choose a different filePath, or have the user open ${name} and save over it deliberately.`,
      });
      return;
    }

    // Read the buffer NOW, after flushing pending keystrokes into it: the
    // approval checks above awaited, and the user may have kept typing — or
    // closed the tab, in which case there is nothing left to save and the
    // copy resolved earlier must not be written out in its place.
    flushLiveEditors();
    const live = useDocumentStore.getState().documents[tabId];
    if (!live) {
      await structuredError(id, { error: "INVALID_TAB", message: "No document for tab" });
      return;
    }
    const outcome = await saveTabForBridge(tabId, filePath, live.content, "workspace.save_as");
    if (!outcome.saved) {
      await respondSaveFailed(id, outcome);
      return;
    }
    const revision = useRevisionStore.getState().getRevision(tabId);
    await respond({ id, success: true, data: { revision } });
  });
}
