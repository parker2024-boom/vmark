/**
 * What to do when an open file's bytes changed on disk.
 *
 * Purpose: the per-tab REACTION policy for a modify-like event — restore,
 *   no-op, un-diverge, auto-reload, or queue a conflict for the user.
 *
 * Extracted from `useExternalFileChanges`, where it was a 60-line branch inside
 * a hook. Nothing here is React: it is a function of the document's current
 * state and the bytes now on disk, and it is tested as one.
 *
 * Key decisions:
 *   - Disk-vs-store comparison is SOFT (`softContentEquals`), because cloud
 *     sync daemons (OneDrive, iCloud, Dropbox) rewrite files touching only line
 *     endings, the BOM, or the trailing newline. A byte comparison reported
 *     those as external changes and prompted the user for nothing.
 *   - A soft-equal rewrite still refreshes `lastDiskContent`, or the NEXT byte
 *     comparison would fail the same way and the sync would slip through again.
 *   - The `auto_reload` case deliberately does not `clearMissing`: the
 *     `isMissing` branch returns in both its arms and nothing between that read
 *     and the switch awaits, so a missing document cannot reach it. The call
 *     was a no-op that still wrote to the store and woke every subscriber.
 *   - The editors are FLUSHED before any branch reads `isDirty` or `content`.
 *     A WYSIWYG editor delivers keystrokes to the store on a debounce (a frame
 *     for a small document, seconds for a large one), so the store's dirty
 *     flag trails what the user typed. A formatter rewriting the file inside
 *     that window met a document that still looked clean, the policy reloaded
 *     it, and the keystrokes were gone under a "Reloaded" toast.
 *   - The flush comes AFTER the unchanged-on-disk check, which reads neither
 *     field. A flush serializes the whole document; an echo of our own save or
 *     a sync daemon touching line endings needs no decision and must not pay
 *     for one.
 *   - While an IME composition is in progress in the editor showing this tab,
 *     the decision WAITS until it has ended and been cleaned up. Mid-
 *     composition the flush writes the uncommitted preedit text into the store
 *     as if it were typing, and a reload replaces the document under the text
 *     the browser is still composing. The unchanged-on-disk check still runs
 *     at once: it touches the store, never the editor.
 *
 * @coordinates-with hooks/useExternalFileChanges.ts — sole caller
 * @coordinates-with utils/openPolicy — resolveExternalChangeAction
 * @coordinates-with utils/wysiwygFlush.ts — brings pending keystrokes into the store
 * @coordinates-with services/ime/compositionWriteGate.ts — holds the decision while composing
 * @module services/files/applyModifyPolicy
 */
import type { EditorView } from "@tiptap/pm/view";
import { useDocumentStore } from "@/stores/documentStore";
import { useEditorStore } from "@/stores/editorStore";
import { imeToast as toast } from "@/services/ime/imeToast";
import {
  isCompositionInProgress,
  writeWhenCompositionSettles,
} from "@/services/ime/compositionWriteGate";
import i18n from "@/i18n";
import { getFileName } from "@/utils/paths";
import { softContentEquals } from "@/utils/linebreaks";
import { resolveExternalChangeAction } from "@/utils/openPolicy";
import { flushAllWysiwygNow } from "@/utils/wysiwygFlush";

/** Ask the user about a conflict on this tab (debounced and batched). */
export type QueueDirtyChange = (tabId: string, filePath: string) => void;

/** The live WYSIWYG view showing `tabId`, if an IME composition is in progress in it. */
function composingViewFor(tabId: string): EditorView | null {
  const { activeWysiwygEditor, activeWysiwygTabId } = useEditorStore.getState().active;
  if (activeWysiwygTabId !== tabId) return null;
  const view = activeWysiwygEditor?.view;
  return view && isCompositionInProgress(view) ? view : null;
}

/**
 * Apply the reaction policy for a modify-like event.
 *
 * Shared by the modify/create branch and the rename fallback, because a
 * Windows atomic save (MoveFileEx) arrives as a rename whose target is simply
 * the file's new bytes.
 */
export function applyModifyPolicy(
  tabId: string,
  changedPath: string,
  diskContent: string,
  queueDirtyChange: QueueDirtyChange,
): void {
  const unflushed = useDocumentStore.getState().getDocument(tabId);
  if (!unflushed) return;

  // Disk matches what we last wrote — no actual external change. See the header
  // for why this comparison is soft and why it still refreshes the snapshot.
  // A missing document skips it: a file that reappeared is restored even when
  // its bytes are the ones we last saw.
  if (!unflushed.isMissing && softContentEquals(diskContent, unflushed.lastDiskContent)) {
    if (diskContent !== unflushed.lastDiskContent) {
      useDocumentStore.getState().updateLastDiskContent(tabId, diskContent);
    }
    return;
  }

  // Mid-composition the decision waits — see the header. The deferred call
  // starts over, so it decides on the document as it is then.
  const composingView = composingViewFor(tabId);
  if (composingView) {
    writeWhenCompositionSettles(composingView, () =>
      applyModifyPolicy(tabId, changedPath, diskContent, queueDirtyChange),
    );
    return;
  }

  // Every branch below decides on `isDirty` or `content`, so the store has to
  // hold what the user has typed — see the header.
  flushAllWysiwygNow();
  const doc = useDocumentStore.getState().getDocument(tabId);
  /* v8 ignore next -- @preserve a flush writes to documents, it never removes one; the guard narrows the type */
  if (!doc) return;

  // File reappeared after deletion — reload unless the user has unsaved edits.
  if (doc.isMissing) {
    if (doc.isDirty) {
      queueDirtyChange(tabId, changedPath);
      return;
    }
    useDocumentStore
      .getState()
      .ingestExternalContent(tabId, diskContent, "disk-open", { filePath: changedPath });
    useDocumentStore.getState().clearMissing(tabId);
    toast.info(i18n.t("dialog:toast.restored", { filename: getFileName(changedPath) }));
    return;
  }

  // Divergent doc: disk now matches the editor — clear the divergent state so
  // auto-save resumes. Happens when e.g. a git checkout restores the same
  // content the editor is already showing.
  if (doc.isDivergent && softContentEquals(diskContent, doc.content)) {
    useDocumentStore
      .getState()
      .ingestExternalContent(tabId, diskContent, "disk-open", { filePath: changedPath });
    return;
  }

  const action = resolveExternalChangeAction({
    isDirty: doc.isDirty,
    hasFilePath: Boolean(doc.filePath),
  });

  switch (action) {
    case "auto_reload":
      useDocumentStore
        .getState()
        .ingestExternalContent(tabId, diskContent, "disk-open", { filePath: changedPath });
      toast.info(i18n.t("dialog:toast.reloaded", { filename: getFileName(changedPath) }));
      break;
    case "prompt_user":
      queueDirtyChange(tabId, changedPath);
      break;
    case "no_op":
      break;
  }
}
