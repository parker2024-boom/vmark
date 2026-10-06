/**
 * Shared helpers for multi-cursor commands.
 *
 * Range-membership, next-occurrence lookup, and selection-building logic
 * used by both the occurrence commands (occurrenceCommands.ts) and the
 * cursor commands (cursorCommands.ts). Extracted from commands.ts.
 *
 * @module plugins/multiCursor/commandHelpers
 */

import { SelectionRange } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { MultiSelection } from "@/plugins/shared/MultiSelection";
import { normalizeRangesWithPrimary } from "@/plugins/shared/rangeUtils";

/**
 * Check if a position falls within any existing range (boundaries inclusive).
 * Covers both exact collapsed-cursor duplicates and positions inside a
 * non-empty selection range — a new collapsed cursor must not land in either.
 */
export function positionWithinRanges(
  ranges: readonly SelectionRange[],
  pos: number
): boolean {
  return ranges.some((r) => r.$from.pos <= pos && pos <= r.$to.pos);
}

/**
 * Find the next unused occurrence after a given position, wrapping around.
 * Returns the first occurrence not already in `existingRanges`.
 *
 * Membership is a set lookup: after wrapping, the search passes every
 * occurrence already selected, so checking each against every range made
 * one Cmd+D quadratic in the cursor count.
 */
export function findNextUnusedOccurrence(
  occurrences: Array<{ from: number; to: number }>,
  afterPos: number,
  beforePos: number,
  existingRanges: readonly SelectionRange[]
): { from: number; to: number } | null {
  const used = new Set(existingRanges.map((r) => `${r.$from.pos}:${r.$to.pos}`));
  const unused = (occ: { from: number; to: number }) => !used.has(`${occ.from}:${occ.to}`);
  // Look after the given position; then wrap around and look before it.
  return (
    occurrences.find((occ) => occ.from >= afterPos && unused(occ)) ??
    occurrences.find((occ) => occ.from < beforePos && unused(occ)) ??
    null
  );
}

/**
 * Build a MultiSelection from the existing ranges plus one new range, with
 * the new range as primary (normalization re-sorts; the primary index
 * follows the added range).
 */
export function selectionWithAddedPrimaryRange(
  doc: Node,
  existingRanges: readonly SelectionRange[],
  range: { from: number; to: number }
): MultiSelection {
  const $from = doc.resolve(range.from);
  const $to = doc.resolve(range.to);
  const newRanges = [...existingRanges, new SelectionRange($from, $to)];
  const normalized = normalizeRangesWithPrimary(
    newRanges,
    doc,
    newRanges.length - 1
  );
  return new MultiSelection(normalized.ranges, normalized.primaryIndex);
}
