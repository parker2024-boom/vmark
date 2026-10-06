/**
 * Multi-cursor Mapping Index
 *
 * Purpose: map many positions through a long list of step maps without
 * walking every map for every position. A multi-cursor edit adds one step per
 * cursor and then maps every cursor through all of them; `Mapping.map` makes
 * that N steps × N cursors. This index answers each position in
 * O(log N + the steps that actually move it), and always returns exactly
 * what `new Mapping(maps).map(pos)` returns.
 *
 * Key decisions:
 *   - Association is always 1, the default every multi-cursor remap uses.
 *   - Each map is summarized by two thresholds read through the public
 *     `StepMap.forEach`: below `identityBelow` it leaves a position where it
 *     is; at or above `shiftFrom` it moves the position by the map's whole
 *     size change. Between them the map itself is consulted.
 *   - Leading maps that leave the position alone are skipped by binary search
 *     on the running minimum of `identityBelow`: every map before the first
 *     one at or below the position leaves it unchanged.
 *   - Trailing maps are summed in one step when the suffix maximum of
 *     `shiftFrom`, adjusted for the shifts before each map, proves every one
 *     of them lies wholly before the position. Edits applied from the end of
 *     the document leave exactly that shape below each cursor.
 *   - Whatever the summaries cannot prove is mapped map by map, so the answer
 *     never depends on the edits being well formed — only the cost does.
 *
 * @coordinates-with rangeEdits.ts — builds one index per multi-cursor edit
 * @module plugins/multiCursor/mappingIndex
 */
import type { StepMap } from "@tiptap/pm/transform";

export interface MappingIndex {
  /**
   * `pos` mapped through every map, as `new Mapping(maps).map(pos)` maps it.
   * Maps from `shiftFrom` on are first tried as one summed shift; pass the
   * end of the steps that edited the position's own range. Any value in
   * `[0, maps.length]` gives the same answer — a good one makes it cheap.
   */
  map(pos: number, shiftFrom: number): number;
}

/** What one map does to positions, as two thresholds and a size change. */
interface MapSummary {
  /** Positions below this are left unchanged. */
  identityBelow: number;
  /** Positions at or above this move by exactly `delta`. */
  shiftFrom: number;
  /** New size minus old size, over every range of the map. */
  delta: number;
}

/**
 * Thresholds follow `StepMap.map` with association 1. A position before a
 * range's start is untouched by it, and so is one exactly at the start of a
 * range that replaces content (it maps to the start's side, -1); one at an
 * insertion point moves past the insertion. A position at or past the end of
 * a range moves by its size change — but a position exactly at the end of an
 * EARLIER range stops there, so it must lie strictly past every range except
 * the last.
 */
function summarize(map: StepMap): MapSummary {
  let identityBelow = Number.POSITIVE_INFINITY;
  let pastEarlier = Number.NEGATIVE_INFINITY;
  let lastEnd = Number.NEGATIVE_INFINITY;
  let delta = 0;
  let first = true;
  map.forEach((oldStart, oldEnd, newStart, newEnd) => {
    if (first) {
      identityBelow = oldEnd > oldStart ? oldStart + 1 : oldStart;
      first = false;
    }
    pastEarlier = Math.max(pastEarlier, lastEnd + 1);
    lastEnd = oldEnd;
    delta += newEnd - newStart - (oldEnd - oldStart);
  });
  return { identityBelow, shiftFrom: Math.max(pastEarlier, lastEnd), delta };
}

/** Index `maps` (applied in order) for repeated position mapping. */
export function indexStepMaps(maps: readonly StepMap[]): MappingIndex {
  const count = maps.length;
  const summaries = maps.map(summarize);

  // prefixMinIdentity[j]: the lowest `identityBelow` among maps 0..j. Non-increasing.
  const prefixMinIdentity = new Array<number>(count);
  // sizeBefore[j]: the summed size change of maps 0..j-1.
  const sizeBefore = new Array<number>(count + 1);
  sizeBefore[0] = 0;
  summaries.forEach((summary, j) => {
    prefixMinIdentity[j] = Math.min(summary.identityBelow, j > 0 ? prefixMinIdentity[j - 1] : Infinity);
    sizeBefore[j + 1] = sizeBefore[j] + summary.delta;
  });
  // suffixMaxShift[j]: the largest `shiftFrom - sizeBefore` among maps j..end.
  // A position p (in the coordinates before map j) moves by plain shifts
  // through all of them iff p - sizeBefore[j] >= suffixMaxShift[j].
  const suffixMaxShift = new Array<number>(count + 1);
  suffixMaxShift[count] = Number.NEGATIVE_INFINITY;
  for (let j = count - 1; j >= 0; j--) {
    suffixMaxShift[j] = Math.max(summaries[j].shiftFrom - sizeBefore[j], suffixMaxShift[j + 1]);
  }

  /** The first map that may move `pos`, or `count` if none can. */
  function firstMover(pos: number): number {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prefixMinIdentity[mid] <= pos) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  function mapExactly(pos: number, from: number, to: number): number {
    let mapped = pos;
    for (let j = from; j < to; j++) mapped = maps[j].map(mapped);
    return mapped;
  }

  return {
    map(pos, shiftFrom) {
      const start = firstMover(pos);
      if (start === count) return pos;
      const split = Math.max(start, Math.min(shiftFrom, count));
      const atSplit = mapExactly(pos, start, split);
      if (atSplit - sizeBefore[split] >= suffixMaxShift[split]) {
        return atSplit + sizeBefore[count] - sizeBefore[split];
      }
      return mapExactly(atSplit, split, count);
    },
  };
}
