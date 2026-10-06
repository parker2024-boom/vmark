// @vitest-environment node
// WI-RA24.10 — the word-edge search over precomputed segments (a binary
// search) lands exactly where the linear scan it replaced did.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  findWordEdge,
  findWordEdgeInSegments,
  getWordSegments,
  type WordSegment,
} from "./wordSegmentation";

/** The linear scan `findWordEdge` used before, kept as the oracle. */
function linearEdge(segments: WordSegment[], textLength: number, posInText: number, dir: -1 | 1): number | null {
  if (!segments.length) return null;
  const pos = Math.max(0, Math.min(textLength, posInText));
  if (dir < 0) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (pos > segments[i].start) return segments[i].start;
    }
    return segments[0].start;
  }
  for (const seg of segments) if (seg.end > pos) return seg.end;
  return segments[segments.length - 1].end;
}

const PIECES = ["ab", "词", "中文", " ", "  ", ".", "a1", "🙂", "\n", "x-y", "日本語", "안녕"];
const text = fc.array(fc.constantFrom(...PIECES), { maxLength: 12 }).map((p) => p.join(""));

describe("findWordEdgeInSegments", () => {
  it("matches the linear scan for every position and direction", () => {
    fc.assert(
      fc.property(text, fc.integer({ min: -2, max: 40 }), fc.constantFrom(-1 as const, 1 as const), (t, pos, dir) => {
        const segments = getWordSegments(t);
        expect(findWordEdgeInSegments(segments, t.length, pos, dir)).toBe(linearEdge(segments, t.length, pos, dir));
      }),
      { numRuns: 2000 },
    );
  });

  it("is what findWordEdge returns", () => {
    for (const t of ["hello world", "你好世界 hello", "  lead and trail  "]) {
      for (let pos = 0; pos <= t.length; pos++) {
        for (const dir of [-1, 1] as const) {
          expect(findWordEdge(t, pos, dir)).toBe(findWordEdgeInSegments(getWordSegments(t), t.length, pos, dir));
        }
      }
    }
  });

  it.each([
    ["no segments", [], 5, 1, null],
    ["before the first word, moving left", [{ start: 2, end: 4 }], 1, -1, 2],
    ["after the last word, moving right", [{ start: 0, end: 2 }], 9, 1, 2],
    ["inside a word, moving left", [{ start: 0, end: 5 }], 3, -1, 0],
    ["at a word's end, moving right to the next", [{ start: 0, end: 2 }, { start: 3, end: 5 }], 2, 1, 5],
    ["a position past the text is clamped", [{ start: 0, end: 2 }, { start: 3, end: 5 }], 99, -1, 3],
  ] as const)("%s", (_label, segments, pos, dir, expected) => {
    expect(findWordEdgeInSegments(segments, 5, pos, dir)).toBe(expected);
  });
});
