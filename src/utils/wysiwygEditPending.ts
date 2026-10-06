/**
 * WYSIWYG Edit-Pending Signal
 *
 * Purpose: let code outside the WYSIWYG editor ask "has the user typed
 * something that is not in the document store yet?" without importing the
 * editor. Auto-save asks on every tick: answering it costs nothing, while the
 * flush it would otherwise run serializes the whole document.
 *
 * Key decisions:
 *   - Set synchronously by the editor when an edit schedules a flush, cleared
 *     when a flush writes that edit to the store. Between the two, the edit
 *     exists only in the editor, and a reader of the store must flush first.
 *   - Keyed by editor instance, so several mounted editors (split panes,
 *     kept-alive tabs) each hold their own flag and one flushing does not
 *     clear another's.
 *   - It says nothing about whether the document is dirty: an edit that has
 *     been flushed is no longer pending here and is the store's to report.
 *
 * @coordinates-with components/Editor/useTiptapFlush.ts — sets and clears the flag
 * @coordinates-with hooks/useAutoSave.ts — flushes only when a flag is set
 * @coordinates-with utils/wysiwygFlush.ts — the flush this decides whether to run
 * @module utils/wysiwygEditPending
 */

const editorsWithPendingEdit = new Set<object>();

/** Record whether `editor` holds a user edit that has not reached the document store. */
export function setWysiwygEditPending(editor: object, pending: boolean): void {
  if (pending) editorsWithPendingEdit.add(editor);
  else editorsWithPendingEdit.delete(editor);
}

/** Whether any WYSIWYG editor in this window holds an edit the document store has not seen. */
export function hasPendingWysiwygEdit(): boolean {
  return editorsWithPendingEdit.size > 0;
}
