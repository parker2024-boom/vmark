/**
 * Multi-cursor Clipboard Handling
 *
 * Purpose: Manages cut/copy/paste operations across multiple cursor positions.
 * Serializes multi-selection content with newline separators for copy, and
 * distributes pasted text across cursors (one line per cursor when line count matches).
 *
 * Key decisions:
 *   - Copy joins ranges with newlines (each range on its own line)
 *   - Paste splits by newline; if line count matches range count, distributes 1:1
 *   - Cut and paste edit in reverse doc order to preserve positions
 *
 * @coordinates-with multiCursorPlugin.ts — integrates clipboard handlers into the plugin
 * @coordinates-with rangeEdits.ts — applies the per-range edits from the end and maps the ranges
 * @coordinates-with shared/rangeUtils.ts — merges overlapping ranges before editing
 * @module plugins/multiCursor/clipboard
 */
import { SelectionRange } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { MultiSelection } from "@/plugins/shared/MultiSelection";
import { normalizeRangesWithPrimary } from "@/plugins/shared/rangeUtils";
import { editRangesFromEnd } from "./rangeEdits";

/**
 * Serialize multi-selection content for clipboard.
 */
export function getMultiCursorClipboardText(state: EditorState): string {
  const { selection } = state;
  if (!(selection instanceof MultiSelection)) return "";
  return selection.getTextContent(state.doc);
}

/**
 * Handle cut for multi-cursor selections.
 * Deletes text at all selections (cursors with no selection are no-ops).
 *
 * @returns Transaction or null if not a MultiSelection or nothing to cut
 */
export function handleMultiCursorCut(
  state: EditorState
): Transaction | null {
  const { selection } = state;

  if (!(selection instanceof MultiSelection)) {
    return null;
  }

  const hasNonEmptyRange = selection.ranges.some(
    (r) => r.$from.pos !== r.$to.pos
  );
  if (!hasNonEmptyRange) return null;

  // Pre-merge overlapping ranges so each edit targets a disjoint span
  const preMerged = normalizeRangesWithPrimary(
    selection.ranges, state.doc, selection.primaryIndex, true
  );
  const edits = editRangesFromEnd(state, preMerged.ranges, (tr, range) =>
    range.$from.pos !== range.$to.pos ? tr.delete(range.$from.pos, range.$to.pos) : tr
  );
  let { tr } = edits;

  // Remap all cursors to collapsed positions
  const newRanges: SelectionRange[] = preMerged.ranges.map((range, index) => {
    const newPos = edits.map(index, range.$from.pos);
    const $pos = tr.doc.resolve(newPos);
    return new SelectionRange($pos, $pos);
  });

  const normalized = normalizeRangesWithPrimary(
    newRanges,
    tr.doc,
    preMerged.primaryIndex,
    true
  );

  const newSel = new MultiSelection(normalized.ranges, normalized.primaryIndex);
  tr = tr.setSelection(newSel);
  tr = tr.setMeta("addToHistory", true);

  return tr;
}

/**
 * Handle paste for multi-cursor selections.
 * Distributes lines if line count matches cursor count.
 */
export function handleMultiCursorPaste(
  state: EditorState,
  text: string
): Transaction | null {
  const { selection } = state;

  if (!(selection instanceof MultiSelection)) {
    return null;
  }

  // Pre-merge overlapping ranges so each edit targets a disjoint span
  const preMerged = normalizeRangesWithPrimary(
    selection.ranges, state.doc, selection.primaryIndex, true
  );
  const ranges = preMerged.ranges;
  /* v8 ignore next -- @preserve MultiSelection always has at least one range; empty guard is defensive */
  if (ranges.length === 0) return null;

  const lines = text.split(/\r?\n/);
  const textsToInsert =
    lines.length === ranges.length ? lines : ranges.map(() => text);

  const edits = editRangesFromEnd(state, ranges, (tr, range, index) =>
    tr.insertText(textsToInsert[index], range.$from.pos, range.$to.pos)
  );
  let { tr } = edits;

  const newRanges: SelectionRange[] = ranges.map((range, index) => {
    const newFrom = edits.map(index, range.$from.pos);
    const newTo = edits.map(index, range.$to.pos);
    const newPos = Math.max(newFrom, newTo);
    const $pos = tr.doc.resolve(newPos);
    return new SelectionRange($pos, $pos);
  });

  const normalized = normalizeRangesWithPrimary(
    newRanges,
    tr.doc,
    preMerged.primaryIndex,
    true
  );

  const newSel = new MultiSelection(normalized.ranges, normalized.primaryIndex);
  tr = tr.setSelection(newSel);
  tr = tr.setMeta("addToHistory", true);

  return tr;
}
