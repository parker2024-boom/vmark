/**
 * Purpose: keep the mounted WYSIWYG editor and the document store in step
 * while a bridge handler reads or replaces a document.
 *
 * The store is what the bridge reads and saves, but while a tab is open in
 * WYSIWYG mode the EDITOR holds the truth and the store trails it: keystrokes
 * reach the store on a debounced flush (a frame for small documents, seconds
 * for large ones), and the store's text is the editor's serialization, not
 * whatever text was loaded into it. A handler that ignores either fact reports
 * a state that stops being true a frame later.
 *
 * Key decisions:
 *   - Flush BEFORE reading. `flushLiveEditors` brings pending keystrokes into
 *     the store (bumping the revision as an edit does), so a read returns what
 *     the user sees, a save writes it, and a write based on an older read is
 *     refused as stale instead of silently replacing typing it never saw.
 *   - A replaced document is a LOAD, not typing. The transaction carries
 *     `preventUpdate`, the mark the editor's own content loads use, so the
 *     editor does not schedule a flush that would write its re-serialization
 *     back as a user edit — which re-dirtied a document one frame after it was
 *     reported saved. It stays in the undo history: the user can undo an AI
 *     write.
 *   - Flush AFTER loading. The store then holds exactly the text the editor
 *     serializes to, and the editor knows the store holds it, so its content
 *     sync does not parse and load the same document a second time.
 *     The consequence is deliberate: for the live WYSIWYG tab the buffer — and
 *     so what gets saved — is the editor's serialization of the client's text,
 *     not its exact characters. Disk, store and editor then agree, which no
 *     other choice can offer while the editor holds a parsed document.
 *   - A write into an editor with an IME composition in progress is REFUSED,
 *     not deferred. The browser owns the preedit text and its DOM node until
 *     the composition ends and is cleaned up; a replaced document under it is
 *     committed or dropped by WebKit. A handler must answer its client now, so
 *     it asks `liveCompositionRefusal` before it touches the store and answers
 *     BUSY; the client retries once the user has finished typing.
 *   - Only the editor registered as the active WYSIWYG editor is loaded
 *     directly. A tab also mounted in an unfocused split pane is updated by
 *     that pane's own content sync — a `preventUpdate` load, which the
 *     revision tracker does not count as a change.
 *
 * @coordinates-with utils/wysiwygFlush.ts — the flusher registry
 * @coordinates-with components/Editor/useTiptapFlush.ts — what a flush does
 * @coordinates-with components/Editor/tiptapContentLoad.ts — the editor's own content loads
 * @coordinates-with services/mcpBridge/revisionTracker.ts — bumps on edits, not on `preventUpdate` loads
 * @coordinates-with services/ime/compositionWriteGate.ts — whether a composition is in progress
 * @module services/mcpBridge/v2/liveEditor
 */
import { useEditorStore } from "@/stores/editorStore";
import { parseMarkdown } from "@/utils/markdownPipeline";
import { flushAllWysiwygNow } from "@/utils/wysiwygFlush";
import { getSerializeOptions } from "@/plugins/toolbarActions/wysiwygAdapterUtils";
import { mcpBridgeLog } from "@/utils/debug";
import { isCompositionInProgress } from "@/services/ime/compositionWriteGate";
import type { Editor } from "@tiptap/core";
import type { V2Error } from "./types";

/**
 * Bring the document store up to date with every mounted WYSIWYG editor.
 * Call before a handler reads a tab's content, dirty flag or revision.
 */
export function flushLiveEditors(): void {
  flushAllWysiwygNow();
}

/**
 * The refusal a bridge write gets while the editor it would change has an IME
 * composition in progress. BUSY: the state is transient, and the client
 * should retry shortly.
 */
export function composingRefusal(): V2Error {
  return {
    error: "BUSY",
    message: "The user is composing text with an input method in this document; retry shortly",
  };
}

/** The live WYSIWYG editor, when it is showing `tabId`. */
function liveWysiwygEditor(tabId: string): Editor | null {
  const { tiptap, active } = useEditorStore.getState();
  const editor = tiptap.editor;
  return editor && active.activeWysiwygTabId === tabId ? editor : null;
}

/**
 * The refusal for a write to `tabId` while the live WYSIWYG editor showing it
 * has an IME composition in progress; `null` when the write may go ahead (the
 * tab is not the one on screen, or nobody is composing).
 *
 * Ask BEFORE changing the store: a refused write must change nothing.
 */
export function liveCompositionRefusal(tabId: string): V2Error | null {
  const editor = liveWysiwygEditor(tabId);
  return editor && isCompositionInProgress(editor.view) ? composingRefusal() : null;
}

/**
 * Show `content` in the live WYSIWYG editor, if `tabId` is the tab it is
 * showing, and bring the store to the text the editor now holds.
 *
 * Returns whether the editor took the content. `false` means the store keeps
 * whatever the caller put there: the tab is in the background or in Source
 * mode (the live editor shows a different document, and dispatching into it
 * would replace that one), or the content could not be parsed — the editor
 * then keeps its old document and its own content sync reports the tab as
 * unparseable and moves it to Source mode.
 *
 * Throws while an IME composition is in progress in that editor: the caller
 * was required to ask `liveCompositionRefusal` first and answer BUSY.
 */
export function loadIntoLiveWysiwyg(tabId: string, content: string): boolean {
  const editor = liveWysiwygEditor(tabId);
  if (!editor) return false;
  const view = editor.view;
  if (isCompositionInProgress(view)) {
    throw new Error("loadIntoLiveWysiwyg: an IME composition is in progress; ask liveCompositionRefusal first");
  }
  try {
    const next = parseMarkdown(editor.schema, content, {
      preserveLineBreaks: getSerializeOptions().preserveLineBreaks,
    });
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, next.content)
        .setMeta("addToHistory", true)
        .setMeta("preventUpdate", true),
    );
  } catch (error) {
    // Not flushed: the editor still holds the OLD document, and flushing it
    // would write that over the content the caller just stored.
    mcpBridgeLog("live editor did not take the written content:", error);
    return false;
  }
  flushAllWysiwygNow();
  return true;
}
