/**
 * Save All and Quit
 *
 * Purpose: save every open document in every window, then quit — the
 *   quit-time counterpart of the whole-window close, without its prompts.
 *
 * Pipeline: the command (menu in Rust, or `handleSaveAllQuit` from the
 *   palette) → Rust starts the coordinated quit in save-all mode → every
 *   document window receives `app:quit-requested` with `saveAll: true`, now or
 *   when it is ready → `useWindowClose` runs `runSaveAllQuitFlow` for its own
 *   window → saved: the window closes through the normal close flow (Rust
 *   quits when the last one is gone); not saved: the window stays open and
 *   answers `cancel_quit`.
 *
 * Key decisions:
 *   - Each WINDOW saves its own documents. A webview's stores hold only its
 *     own tabs, so no single window can save the others' — the coordinator in
 *     Rust asks every one of them. (This used to save the invoking window and
 *     leave the rest to ask about their documents.)
 *   - Open TABS decide what is saved, through the same collector the window
 *     close uses. The document store is never iterated: a document with no
 *     live tab is not open, and writing it would put a discarded buffer on
 *     disk.
 *   - Divergent documents are saved too. Quitting is a close, and a document
 *     the user kept after an external edit is exactly what a close must not
 *     drop in silence; "save all" is the explicit instruction to write it.
 *   - Untitled documents still ask where to go: one Save As dialog, or one
 *     folder picker for several, in the window that holds them. Cancelling it
 *     keeps that window open and cancels the quit.
 *   - Nothing captured before a dialog is trusted after it. The Save As dialog
 *     and the folder picker stay open for as long as the user takes, and an
 *     edit (human or MCP), a save through another path or a tab close can land
 *     meanwhile. Each write therefore re-reads the live document: what is
 *     written is what the buffer holds at that moment, and a document that no
 *     longer needs saving is not written at all.
 *   - The dirty set is REVALIDATED after every save pass, the same loop the
 *     window close runs. Saves yield, so an edit can land during a write; it
 *     gets another pass instead of being lost to the quit. Bounded: documents
 *     that will not come to rest are a refusal, never a close over unsaved
 *     content. The close flow that follows checks once more, and asks about
 *     anything dirtied after the last pass rather than dropping it.
 *   - A failed write is never quit over: the window stays open, the save
 *     path's own error toast says why, and the quit is cancelled.
 *
 * @coordinates-with src-tauri/src/quit.rs — `save_all_and_quit`, the save-all quit mode
 * @coordinates-with hooks/useWindowClose.ts — answers the quit request with this flow
 * @coordinates-with services/windowClose/dirtyContexts.ts — which tabs still need saving, and the loop bound
 * @coordinates-with services/windowClose/closeSaveBatch.ts — the batch writer and its revalidate hook
 * @coordinates-with services/windowClose/windowCloseFlow.ts — the close that follows the saves
 * @coordinates-with services/commands/fileCommands.ts — binds the command (via fileSave.ts)
 * @module services/files/saveAllQuit
 */

import { invoke } from "@tauri-apps/api/core";
import i18n from "@/i18n";
import { imeToast as toast } from "@/services/ime/imeToast";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { flushAllWysiwygNow } from "@/utils/wysiwygFlush";
import { saveAllDocuments } from "@/services/windowClose/closeSaveBatch";
import {
  collectDirtyContexts,
  needsResolution,
  MAX_RESOLUTION_ATTEMPTS,
} from "@/services/windowClose/dirtyContexts";
import type { CloseSaveContext } from "@/services/windowClose/closeSaveShared";
import { runWindowCloseFlow, type CloseLog } from "@/services/windowClose/windowCloseFlow";
import { fileOpsError } from "@/utils/debug";

/**
 * Start Save All and Quit: Rust asks every document window to save its
 * documents and close, and quits when the last one has.
 */
export async function handleSaveAllQuit(): Promise<void> {
  await invoke("save_all_and_quit");
}

/** Save contexts for the open tabs of `windowLabel` that still need saving. */
function collectWindowDirtyContexts(windowLabel: string): CloseSaveContext[] {
  // Sync every mounted editor first: an edit still in the debounce window is
  // otherwise invisible to the check.
  flushAllWysiwygNow();
  return collectDirtyContexts(windowLabel, useTabStore.getState().tabs[windowLabel] ?? []);
}

/**
 * The context to write NOW, or `null` when there is nothing left to save: the
 * tab was closed, or the document came to rest by another path, since the
 * context was captured.
 */
function liveContext(context: CloseSaveContext): CloseSaveContext | null {
  flushAllWysiwygNow();
  if (!useTabStore.getState().findTabById(context.tabId)) return null;
  const doc = useDocumentStore.getState().getDocument(context.tabId);
  if (!doc || !needsResolution(doc)) return null;
  return { ...context, filePath: doc.filePath ?? context.filePath, content: doc.content };
}

/**
 * Save every open document of the window that needs it, asking only where an
 * untitled one goes. True when the window's documents are all at rest.
 */
async function saveWindowDocuments(windowLabel: string, log: CloseLog): Promise<boolean> {
  try {
    for (let attempt = 0; attempt < MAX_RESOLUTION_ATTEMPTS; attempt++) {
      const contexts = collectWindowDirtyContexts(windowLabel);
      if (contexts.length === 0) return true;
      log(windowLabel, `save-all quit: saving ${contexts.length} document(s)`);
      const result = await saveAllDocuments(contexts, { revalidate: liveContext });
      if (result.action !== "saved-all") {
        // A cancelled dialog is the user's answer; a failed write has already
        // shown its own error. Either way nothing is closed over it.
        log(windowLabel, "save-all quit: a save was cancelled or failed — staying open");
        return false;
      }
      // Loop: revalidate. A document dirty again after its save was edited
      // while the batch ran — it gets another pass, not a close over it.
    }
    // Documents kept changing faster than they could be saved — refuse.
    fileOpsError("Save All and Quit abandoned: documents would not come to rest");
  } catch (error) {
    fileOpsError("Save All and Quit failed:", error);
  }
  toast.error(i18n.t("dialog:toast.failedToSaveDocuments"));
  return false;
}

/**
 * This window's answer to a save-all quit: save its documents without the
 * save prompts, then close it through the normal close flow. Resolves `false`
 * when the window stays open, which the caller reports to Rust as a cancelled
 * quit.
 */
export async function runSaveAllQuitFlow(windowLabel: string, log: CloseLog): Promise<boolean> {
  if (!(await saveWindowDocuments(windowLabel, log))) return false;
  return runWindowCloseFlow(windowLabel, log);
}
