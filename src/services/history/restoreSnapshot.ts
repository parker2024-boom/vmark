/**
 * Restore Snapshot
 *
 * Purpose: put a version from a document's history back on disk — the write
 *   half of "Revert to this Version".
 *
 * Pipeline: flush the editors → check the tab still holds this file → read the
 *   target and snapshot the current text as a safety copy (one history
 *   operation) → decode the target into editor text → `saveToPath` → report
 *   the text now on disk, for the caller to load as the document's baseline.
 *
 * Key decisions:
 *   - The write goes through `saveToPath`, the pipeline every other writer of
 *     a document uses. The revert used to call plugin-fs `writeTextFile`
 *     itself, which truncates and then writes, is not ordered against an
 *     autosave of the same file, and writes the snapshot's bytes as they are.
 *   - A snapshot is not always in the file's convention. One taken from a save
 *     holds the bytes that went to disk; the safety copy a revert takes holds
 *     the editor's text, LF-only and without a byte-order mark. Written as it
 *     was, the second kind turned a CRLF file with a BOM into an LF file
 *     without one. So the target is decoded to editor text first, and the
 *     pipeline re-applies the convention the FILE has now.
 *   - The editors are flushed before the current text is read. A WYSIWYG
 *     editor delivers keystrokes to the store on a debounce, and the safety
 *     copy is the only place the text being replaced survives.
 *   - The tab is named by the caller and checked here, before and after the
 *     save. A revert is confirmed in a dialog; by the time it is answered the
 *     focused tab may be another one, and the tab itself may have been closed
 *     or saved under another name.
 *   - This module does not load the restored text into the document. That is
 *     an ingress into the document store, which lists its callers; the History
 *     sidebar is one and does the load with what is returned here.
 *
 * Known limitations:
 *   - The pipeline records the write as a manual save: its history entry is
 *     typed "manual" and its provenance capture is an editor save, not a
 *     history revert.
 *
 * @coordinates-with historyOperations.ts — revertToSnapshot, the history half
 * @coordinates-with services/persistence/saveToPath.ts — the save pipeline
 * @coordinates-with components/Sidebar/HistoryView.tsx — the caller; loads the result
 * @module services/history/restoreSnapshot
 */

import { useDocumentStore } from "@/stores/documentStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { saveToPath } from "@/services/persistence/saveToPath";
import { ingestExternalText } from "@/utils/editorText";
import { buildHistorySettings } from "@/utils/historyTypes";
import { normalizePath } from "@/utils/paths";
import { flushAllWysiwygNow } from "@/utils/wysiwygFlush";
import { revertToSnapshot } from "./historyOperations";

/** How a restore ended. */
export type RestoreOutcome =
  /** The file now holds the version; `written` is the exact text on disk. */
  | { status: "restored"; written: string }
  /** The tab no longer holds this file (closed, or saved under another name). */
  | { status: "document-changed" }
  /** The version's file is gone; a safety copy of the current text was still taken. */
  | { status: "snapshot-missing" }
  /** The pipeline wrote nothing and has told the user why. */
  | { status: "save-failed" };

/** The tab's document, if it still lives at `filePath`. */
function documentAt(tabId: string, filePath: string) {
  const doc = useDocumentStore.getState().getDocument(tabId);
  if (!doc?.filePath || normalizePath(doc.filePath) !== normalizePath(filePath)) return null;
  return doc;
}

/**
 * Write snapshot `snapshotId` of `filePath` back to that file, as tab `tabId`'s
 * document, keeping the file's line endings and byte-order mark.
 *
 * Rejects only when the safety copy cannot be taken; nothing is written then.
 */
export async function restoreSnapshotToFile(
  tabId: string,
  filePath: string,
  snapshotId: string
): Promise<RestoreOutcome> {
  flushAllWysiwygNow();
  const current = documentAt(tabId, filePath);
  if (!current) return { status: "document-changed" };

  const { general } = useSettingsStore.getState();
  const restored = await revertToSnapshot(
    filePath,
    snapshotId,
    current.content,
    buildHistorySettings(general)
  );
  if (restored === null) return { status: "snapshot-missing" };

  const editorText = ingestExternalText(restored).canonicalEditorText;
  if (!(await saveToPath(tabId, filePath, editorText, "manual"))) {
    return { status: "save-failed" };
  }

  // The pipeline has recorded what it wrote as the document's disk snapshot.
  const saved = documentAt(tabId, filePath);
  if (!saved) return { status: "document-changed" };
  return { status: "restored", written: saved.lastDiskContent };
}
