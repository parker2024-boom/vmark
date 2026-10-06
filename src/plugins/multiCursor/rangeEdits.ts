/**
 * Multi-cursor Range Edits
 *
 * Purpose: apply one edit per selection range in a single transaction — from
 * the end of the document to the start, so each edit's positions are still
 * valid when it runs — and map every range through all of them, at a cost
 * linear in the number of ranges. Typing, Backspace, Delete, Enter, paste and
 * cut all edit this way.
 *
 * Key decisions:
 *   - While the edits run, the transaction tracks a stand-in selection, not
 *     the MultiSelection. `Transaction.insertText` reads `tr.selection` after
 *     its step, and that read re-maps the tracked selection through the new
 *     step: with the MultiSelection, every range mapped, sorted and merged
 *     once per edit — 280 ms per keystroke at 500 cursors. Every caller sets
 *     the final selection itself, so the stand-in is never observed. Setting
 *     it clears stored marks, so they are put back for the first edit to use,
 *     exactly as a plain transaction offers them.
 *   - Ranges are edited in the order a stable sort by descending start gives:
 *     ranges that start together keep their input order.
 *   - Mapping goes through a `MappingIndex`, which skips the steps that cannot
 *     move a range instead of walking all of them for every range, and returns
 *     what `tr.mapping.map(pos)` returns.
 *
 * @coordinates-with mappingIndex.ts — the position mapping
 * @coordinates-with inputHandling.ts, enterHandling.ts, clipboard.ts — the callers
 * @module plugins/multiCursor/rangeEdits
 */
import { Selection } from "@tiptap/pm/state";
import type { EditorState, SelectionRange, Transaction } from "@tiptap/pm/state";
import { indexStepMaps } from "./mappingIndex";

/**
 * Edits one range; returns the transaction to continue with. `index` is the
 * range's position in the input array, so per-range data can be looked up.
 */
export type RangeEdit = (tr: Transaction, range: SelectionRange, index: number) => Transaction;

export interface RangeEdits {
  /** Every edit applied. Its selection is a stand-in: the caller must set the real one. */
  readonly tr: Transaction;
  /**
   * `pos`, a position of `ranges[index]` before the edits, after all of them
   * — the value `tr.mapping.map(pos)` returns.
   */
  map(index: number, pos: number): number;
}

/**
 * Apply `edit` to every range, last range first, in one transaction.
 *
 * @param state - The state the ranges belong to
 * @param ranges - Disjoint ranges to edit (merge overlapping ones first)
 * @param edit - The edit for one range
 */
export function editRangesFromEnd(
  state: EditorState,
  ranges: readonly SelectionRange[],
  edit: RangeEdit
): RangeEdits {
  let tr = state.tr.setSelection(Selection.atStart(state.doc));
  if (state.storedMarks) tr = tr.setStoredMarks(state.storedMarks);

  const order = ranges
    .map((_, index) => index)
    .sort((a, b) => ranges[b].$from.pos - ranges[a].$from.pos);
  const stepsAfterOwnEdit = new Array<number>(ranges.length);
  for (const index of order) {
    tr = edit(tr, ranges[index], index);
    stepsAfterOwnEdit[index] = tr.steps.length;
  }

  const mapping = indexStepMaps(tr.mapping.maps);
  return {
    tr,
    map: (index, pos) => mapping.map(pos, stepsAfterOwnEdit[index]),
  };
}
