// @vitest-environment node
// WI-RA23.1 — an indexed mapping returns exactly what ProseMirror's Mapping
// returns, for any step maps and any position.
//
// Multi-cursor edits map every range through every edit; the index exists to
// skip the steps that cannot move a position. Skipping is only sound if the
// answer never changes, so these properties compare it with `Mapping.map` on
// arbitrary step maps — zero-size ranges, adjacent ranges, several ranges in
// one map, deletions that swallow the position — and on every split point.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { indexStepMaps } from "../mappingIndex";

/** One StepMap: sorted, non-overlapping old ranges, as a step produces. */
const stepMapArb = fc
  .array(
    fc.record({
      gap: fc.integer({ min: 0, max: 6 }),
      oldSize: fc.integer({ min: 0, max: 4 }),
      newSize: fc.integer({ min: 0, max: 4 }),
    }),
    { maxLength: 3 },
  )
  .map((parts) => {
    const ranges: number[] = [];
    let at = 0;
    for (const { gap, oldSize, newSize } of parts) {
      at += gap;
      ranges.push(at, oldSize, newSize);
      at += oldSize;
    }
    return new StepMap(ranges);
  });

describe("indexStepMaps", () => {
  it("maps every position exactly as Mapping.map does, from any split point", () => {
    fc.assert(
      fc.property(fc.array(stepMapArb, { maxLength: 8 }), (maps) => {
        const index = indexStepMaps(maps);
        const mapping = new Mapping(maps);
        for (let pos = 0; pos <= 40; pos++) {
          const expected = mapping.map(pos);
          for (let shiftFrom = 0; shiftFrom <= maps.length; shiftFrom++) {
            expect(index.map(pos, shiftFrom)).toBe(expected);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it("returns the position unchanged when there are no steps", () => {
    expect(indexStepMaps([]).map(7, 0)).toBe(7);
  });

  it("keeps a position at the start of a replaced range where it is", () => {
    // Replacing 5..7: position 5 stays (it is before the change), 7 follows it.
    const index = indexStepMaps([new StepMap([5, 2, 3])]);
    expect(index.map(5, 0)).toBe(5);
    expect(index.map(7, 0)).toBe(8);
  });

  it("moves a position at an insertion point past the inserted content", () => {
    const index = indexStepMaps([new StepMap([5, 0, 2])]);
    expect(index.map(5, 0)).toBe(7);
    expect(index.map(4, 0)).toBe(4);
  });

  it("sums the edits below a position, applied after the position's own edit", () => {
    // Edits applied from the end of the document: an insertion at 10, then
    // two below it. Position 10 moves past its own insertion, then both shifts.
    const maps = [new StepMap([10, 0, 1]), new StepMap([6, 0, 1]), new StepMap([2, 1, 0])];
    expect(indexStepMaps(maps).map(10, 1)).toBe(new Mapping(maps).map(10));
    expect(indexStepMaps(maps).map(10, 1)).toBe(11);
  });

  it("follows a later edit that swallows the position instead of shifting it", () => {
    // The second step deletes 3..9, which contains position 6 after the first
    // step: no shift summary may apply, the deletion collapses it to 3.
    const maps = [new StepMap([6, 0, 1]), new StepMap([3, 6, 0])];
    expect(indexStepMaps(maps).map(6, 1)).toBe(3);
  });
});
