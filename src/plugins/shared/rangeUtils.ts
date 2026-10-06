/**
 * Range utilities for multi-cursor
 *
 * Handles merging overlapping ranges and sorting/deduplication.
 *
 * @module plugins/shared/rangeUtils
 */

import { SelectionRange } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";

/**
 * Sort ranges by their start position (ascending).
 */
function sortByPosition(ranges: SelectionRange[]): SelectionRange[] {
  return [...ranges].sort((a, b) => a.$from.pos - b.$from.pos);
}

/**
 * Check if two ranges overlap (boundary-touching does not count).
 */
function rangesOverlap(a: SelectionRange, b: SelectionRange): boolean {
  // Treat identical empty ranges as overlap to dedupe cursors
  if (a.$from.pos === a.$to.pos && b.$from.pos === b.$to.pos) {
    return a.$from.pos === b.$from.pos;
  }
  // a ends after b starts (touching at boundary is not overlap)
  return a.$to.pos > b.$from.pos;
}

/**
 * Merge two overlapping/adjacent ranges.
 */
function mergeTwo(a: SelectionRange, b: SelectionRange, doc: Node): SelectionRange {
  const from = Math.min(a.$from.pos, b.$from.pos);
  const to = Math.max(a.$to.pos, b.$to.pos);
  return new SelectionRange(doc.resolve(from), doc.resolve(to));
}

/**
 * Merge overlapping ranges.
 * Returns a new array with merged ranges.
 *
 * @param ranges - Ranges to merge
 * @param doc - Document for resolving positions
 * @returns Merged ranges
 */
export function mergeOverlappingRanges(
  ranges: readonly SelectionRange[],
  doc: Node
): SelectionRange[] {
  if (ranges.length <= 1) {
    return [...ranges];
  }

  // Sort by position first
  const sorted = sortByPosition([...ranges]);
  const result: SelectionRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];

    if (rangesOverlap(last, current)) {
      // Merge with previous
      result[result.length - 1] = mergeTwo(last, current, doc);
    } else {
      // No overlap, add as separate
      result.push(current);
    }
  }

  return result;
}

/**
 * Sort ranges and remove duplicates (same position).
 *
 * @param ranges - Ranges to sort and dedupe
 * @param doc - Document for resolving positions
 * @returns Sorted, deduplicated ranges
 */
export function sortAndDedupeRanges(
  ranges: readonly SelectionRange[],
  _doc: Node
): SelectionRange[] {
  if (ranges.length <= 1) {
    return [...ranges];
  }

  const sorted = sortByPosition([...ranges]);
  const result: SelectionRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];

    // Skip if same position as previous
    if (
      current.$from.pos === last.$from.pos &&
      current.$to.pos === last.$to.pos
    ) {
      continue;
    }

    result.push(current);
  }

  return result;
}

/**
 * Normalize ranges after an operation.
 * Sorts, removes duplicates, and optionally merges overlapping ranges.
 *
 * @param ranges - Ranges to normalize
 * @param doc - Document for resolving positions
 * @param merge - Whether to merge overlapping ranges
 * @returns Normalized ranges
 */
function normalizeRanges(
  ranges: readonly SelectionRange[],
  doc: Node,
  merge = false
): SelectionRange[] {
  if (merge) {
    return mergeOverlappingRanges(ranges, doc);
  }
  return sortAndDedupeRanges(ranges, doc);
}

/**
 * Remap backward flags after normalization.
 *
 * After sorting/deduplication/merging, the normalized ranges may have fewer
 * entries than the original. This function maps each surviving normalized
 * range back to its closest original range (by from-position) and copies
 * the corresponding backward flag.
 *
 * Every cursor's flags are remapped on each arrow key and each edit made
 * elsewhere, so this runs in O(n log n): exact matches come from a map, and
 * a merged range searches only the originals that start inside it (merged
 * ranges overlap at most at their ends, so each original is visited a
 * bounded number of times).
 *
 * @param originalRanges - Ranges before normalization
 * @param originalBackward - Backward flags before normalization (same length as originalRanges)
 * @param normalizedRanges - Ranges after normalization
 * @returns Backward flags matching normalizedRanges length
 */
export function remapBackwardFlags(
  originalRanges: readonly SelectionRange[],
  originalBackward: boolean[],
  normalizedRanges: readonly SelectionRange[]
): boolean[] {
  const key = (range: SelectionRange) => `${range.$from.pos}:${range.$to.pos}`;
  // For dedup: the FIRST original at exactly the same positions.
  const firstExact = new Map<string, number>();
  originalRanges.forEach((range, i) => {
    if (!firstExact.has(key(range))) firstExact.set(key(range), i);
  });
  let byFrom: number[] | null = null;

  return normalizedRanges.map((nr) => {
    const exact = firstExact.get(key(nr));
    if (exact !== undefined) return originalBackward[exact] ?? false;
    // Merged range — the last original (highest index) inside it, as that's
    // the range the user was most recently interacting with.
    byFrom ??= originalRanges
      .map((_, i) => i)
      .sort((a, b) => originalRanges[a].$from.pos - originalRanges[b].$from.pos);
    const inside = lastOriginalInside(originalRanges, byFrom, nr);
    return inside >= 0 ? (originalBackward[inside] ?? false) : false;
  });
}

/** The highest index of an original range inside `outer`, or -1. `byFrom` orders the originals by start. */
function lastOriginalInside(
  originalRanges: readonly SelectionRange[],
  byFrom: readonly number[],
  outer: SelectionRange
): number {
  let lo = 0;
  let hi = byFrom.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (originalRanges[byFrom[mid]].$from.pos < outer.$from.pos) lo = mid + 1;
    else hi = mid;
  }
  let last = -1;
  for (let k = lo; k < byFrom.length && originalRanges[byFrom[k]].$from.pos <= outer.$to.pos; k++) {
    const i = byFrom[k];
    if (originalRanges[i].$to.pos <= outer.$to.pos && i > last) last = i;
  }
  return last;
}

/**
 * Normalize ranges and preserve the primary index.
 * Sorts ranges and removes duplicates, and optionally merges overlaps.
 *
 * @param ranges - Ranges to normalize
 * @param doc - Document for resolving positions
 * @param primaryIndex - Current primary range index
 * @param merge - Whether to merge overlapping ranges
 * @returns Normalized ranges and updated primary index
 */
export function normalizeRangesWithPrimary(
  ranges: readonly SelectionRange[],
  doc: Node,
  primaryIndex: number,
  merge = false
): { ranges: SelectionRange[]; primaryIndex: number } {
  if (ranges.length === 0) {
    return { ranges: [], primaryIndex: 0 };
  }

  const primary = ranges[Math.min(Math.max(primaryIndex, 0), ranges.length - 1)];
  const normalized = normalizeRanges(ranges, doc, merge);

  // Prefer the range that IS the primary — same start and end — before falling
  // back to one that merely contains its start. Containment alone is ambiguous
  // whenever ranges overlap, which the constructor permits since it does not
  // merge: a collapsed cursor at 2 is contained by both [1,2] and [2,2], so
  // `findIndex` picked the earlier one and rebuilding a selection from its own
  // ranges silently moved the primary. The primary supplies $anchor/$head, which
  // drive stored marks and toolbar state, so the user's active cursor changed
  // with no edit.
  const primaryPos = primary.$from.pos;
  const exact = normalized.findIndex(
    (range) => range.$from.pos === primary.$from.pos && range.$to.pos === primary.$to.pos
  );
  const primaryMatch = exact >= 0
    ? exact
    : normalized.findIndex(
        (range) => range.$from.pos <= primaryPos && primaryPos <= range.$to.pos
      );

  return {
    ranges: normalized,
    /* v8 ignore next -- defensive: after containment check, primary is always found */
    primaryIndex: primaryMatch >= 0 ? primaryMatch : 0,
  };
}
