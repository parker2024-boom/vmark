/**
 * Purpose: `vmark.selection.{get, set}` handlers — targeted edits on the
 *   user's current editor selection without paying the full-doc round-trip
 *   that `document.{read, write}` requires on large files.
 *
 *   Restored after the MCP pruning. See ADR-7 in
 *   `.claude/adr/plans/20260504-mcp-pruning.md` for the cost analysis that
 *   motivated re-adding it.
 *
 * Key decisions:
 *   - Selection is view-state, so the request only operates on the
 *     currently focused editor. The `tabId` arg, when supplied, is
 *     verified to match the focused tab; mismatches return INVALID_TAB.
 *   - WYSIWYG (Tiptap) and source (CodeMirror) are both supported, through
 *     one `SelectionSurface` (`selectionSurface.ts`). The `mode` field in
 *     the response tells the AI which position space the `range` lives in
 *     (PM positions vs. character offsets).
 *   - In WYSIWYG, the response's `text` is the markdown serialization of
 *     the selected slice — same canonical representation the AI uses for
 *     `document.read`. `set` parses incoming markdown and replaces the
 *     selected range with the parsed nodes.
 *   - `set` operates on whatever the editor reports as the *current*
 *     selection at call time. If the user moved the cursor between
 *     `get` and `set`, the edit lands at the new position. The
 *     doc-level revision catches keystrokes; pure cursor movement is
 *     not arbitrated by the server.
 *   - `set` refuses BUSY, changing nothing, while the user is composing with
 *     an input method in the focused editor; `get` is never refused.
 *   - After an edit the mounted editor is flushed at once, and the revision
 *     is bumped last, so the revision returned is still the document's
 *     current one after the editor settles (`liveEditor.ts`).
 *
 * @coordinates-with selectionSurface.ts — the WYSIWYG / Source editor adapter
 * @coordinates-with tabGuard.ts — focused-tab resolution, INVALID_TAB and STALE
 * @coordinates-with liveEditor.ts — the flush that keeps the returned revision current
 * @coordinates-with checkpoint.ts — selection.set checkpoints
 * @coordinates-with stores/documentStore/revision.ts — optimistic concurrency
 * @module services/mcpBridge/v2/selection
 */

import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { respond } from "@/services/mcpBridge/utils";
import { wrapHandler } from "./wrapHandler";
import { describeSizeChange, recordBridgeCheckpoint } from "./checkpoint";
import { flushLiveEditors } from "./liveEditor";
import { readOperationArgs } from "./readOperationArgs";
import { resolveSelectionSurface } from "./selectionSurface";
import { requireCurrentRevision, requireTab, structuredError } from "./tabGuard";

/**
 * Handle `vmark.selection.get`. Args: `{tabId?: string}`.
 */
export async function handleSelectionGet(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.selection.get", args);
    const tab = await requireTab(id, wire.tabId, "focused");
    if (!tab) return;
    const surface = resolveSelectionSurface(tab.tabId);
    if ("error" in surface) {
      await structuredError(id, surface);
      return;
    }

    const range = surface.range();
    await respond({
      id,
      success: true,
      data: {
        text: surface.selectedText(),
        isEmpty: range.from === range.to,
        range,
        mode: surface.mode,
        kind: tab.kind,
        tabId: tab.tabId,
        revision: useRevisionStore.getState().getRevision(tab.tabId),
      },
    });
  });
}

/**
 * Handle `vmark.selection.set`.
 *
 * Args: `{tabId?, content: string, expected_revision?: string}`.
 */
export async function handleSelectionSet(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  return wrapHandler(id, async () => {
    const wire = readOperationArgs("vmark.selection.set", args);
    if (wire.content === undefined) {
      await structuredError(id, { error: "INTERNAL", message: "content must be a string" });
      return;
    }
    const { content } = wire;

    const tab = await requireTab(id, wire.tabId, "focused");
    if (!tab) return;
    const surface = resolveSelectionSurface(tab.tabId);
    if ("error" in surface) {
      await structuredError(id, surface);
      return;
    }
    if (!(await requireCurrentRevision(id, tab.tabId, wire.expected_revision))) return;
    // Asked after the last await, so nothing can start a composition between
    // the answer and the replacement.
    const refusal = surface.writeRefusal();
    if (refusal) {
      await structuredError(id, refusal);
      return;
    }

    const revisionStore = useRevisionStore.getState();
    const revisionBefore = revisionStore.getRevision(tab.tabId);
    const selectedText = surface.selectedText();
    const contentBefore = surface.documentText();

    surface.replaceSelection(content);
    // Flush the mounted editor NOW: the store then holds its serialization
    // and the editor knows it, so its content sync does not parse and load
    // the same document again.
    flushLiveEditors();
    // Mirror the editor into the store. After a flush this is the same text;
    // it is what covers an editor that has no flusher registered.
    const contentAfter = surface.documentText();
    useDocumentStore.getState().setEditorContent(tab.tabId, contentAfter);
    const revisionAfter = revisionStore.updateRevision(tab.tabId);

    if (contentAfter !== contentBefore) {
      recordBridgeCheckpoint({
        tabId: tab.tabId,
        filePath: tab.filePath,
        tool: "selection.set",
        description: describeSizeChange("Replaced selection", selectedText, content),
        contentBefore,
        revisionBefore,
        revisionAfter,
      });
    }
    await respond({
      id,
      success: true,
      data: { revision: revisionAfter, replaced_chars: selectedText.length },
    });
  });
}
