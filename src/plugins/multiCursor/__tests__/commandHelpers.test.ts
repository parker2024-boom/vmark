// @vitest-environment node
// WI-RA23.1 — the next-occurrence search keeps its rules after becoming a set
// lookup: the first unused occurrence starting at or after the current one's
// end, else (wrapping) the first unused one starting before the current one.
import { describe, it, expect } from "vitest";
import { SelectionRange } from "@tiptap/pm/state";
import { findNextUnusedOccurrence } from "../commandHelpers";
import { createDoc } from "./testHelpers";

const doc = createDoc("ab ab ab abab");
const range = (from: number, to: number) => new SelectionRange(doc.resolve(from), doc.resolve(to));
// "ab" at 1-3, 4-6, 7-9, 10-12 and 12-14 (the last two touch).
const occurrences = [
  { from: 1, to: 3 },
  { from: 4, to: 6 },
  { from: 7, to: 9 },
  { from: 10, to: 12 },
  { from: 12, to: 14 },
];

describe("findNextUnusedOccurrence", () => {
  it("takes an occurrence that starts exactly where the current one ends", () => {
    expect(findNextUnusedOccurrence(occurrences, 12, 10, [range(10, 12)])).toEqual({ from: 12, to: 14 });
  });

  it("skips occurrences already selected", () => {
    expect(findNextUnusedOccurrence(occurrences, 3, 1, [range(1, 3), range(4, 6)])).toEqual({ from: 7, to: 9 });
  });

  it("wraps to the first unused occurrence before the current one", () => {
    const selected = [range(1, 3), range(10, 12), range(12, 14)];
    expect(findNextUnusedOccurrence(occurrences, 14, 12, selected)).toEqual({ from: 4, to: 6 });
  });

  it("does not wrap onto or past the current occurrence", () => {
    const selected = [range(1, 3), range(4, 6), range(12, 14)];
    expect(findNextUnusedOccurrence(occurrences, 14, 7, selected)).toBeNull();
  });

  it("counts a range as selected only at the same start and end", () => {
    expect(findNextUnusedOccurrence(occurrences, 3, 1, [range(1, 3), range(4, 5)])).toEqual({ from: 4, to: 6 });
  });

  it("returns null when every occurrence is selected", () => {
    const selected = occurrences.map(({ from, to }) => range(from, to));
    expect(findNextUnusedOccurrence(occurrences, 14, 12, selected)).toBeNull();
  });
});
