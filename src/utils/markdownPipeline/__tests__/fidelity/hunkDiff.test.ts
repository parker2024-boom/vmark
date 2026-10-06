// @vitest-environment node
/**
 * Tests for the line-hunk differ backing the fidelity gate.
 *
 * The gate reports *what the pipeline changed about the author's text*, so the
 * differ must group consecutive changes into reviewable hunks rather than
 * emitting per-line noise, and must report nothing at all for identical input.
 *
 * @module utils/markdownPipeline/__tests__/fidelity/hunkDiff.test
 */
import { describe, it, expect } from "vitest";
import { hunkDiff } from "./hunkDiff";

describe("hunkDiff", () => {
  it("reports no hunks for identical text", () => {
    expect(hunkDiff("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("reports no hunks for empty input on both sides", () => {
    expect(hunkDiff("", "")).toEqual([]);
  });

  it("captures a replaced line as one hunk", () => {
    expect(hunkDiff("a\nb\nc", "a\nX\nc")).toEqual([{ before: ["b"], after: ["X"] }]);
  });

  it("captures a pure insertion (before side empty)", () => {
    expect(hunkDiff("a\nc", "a\nb\nc")).toEqual([{ before: [], after: ["b"] }]);
  });

  it("captures a pure deletion (after side empty)", () => {
    expect(hunkDiff("a\nb\nc", "a\nc")).toEqual([{ before: ["b"], after: [] }]);
  });

  it("groups consecutive changed lines into a single hunk", () => {
    expect(hunkDiff("a\nb\nc\nd", "a\nX\nY\nd")).toEqual([
      { before: ["b", "c"], after: ["X", "Y"] },
    ]);
  });

  it("separates non-adjacent changes into distinct hunks", () => {
    expect(hunkDiff("a\nb\nc\nd\ne", "a\nX\nc\nY\ne")).toEqual([
      { before: ["b"], after: ["X"] },
      { before: ["d"], after: ["Y"] },
    ]);
  });

  it("treats a trailing newline as a distinguishable line", () => {
    // "a" vs "a\n" — the serializer always terminates with a newline, and the
    // gate must be able to see (and a rule explain) that difference.
    expect(hunkDiff("a", "a\n")).toEqual([{ before: [], after: [""] }]);
  });

  it("handles a wholly rewritten document", () => {
    expect(hunkDiff("a\nb", "x\ny")).toEqual([{ before: ["a", "b"], after: ["x", "y"] }]);
  });
});

// WI-RA18.3 — one change is reported as one hunk even when the LCS could
// split it across an unchanged line it shares with its own edge (a blank line
// in a re-spaced loose list), so a rule sees the whole change.
describe("hunkDiff compaction across an identical unchanged line", () => {
  it("joins an insertion to the change before it", () => {
    const authored = "1. a\n\n7. x\n8. y\n\nT";
    const returned = "1. a\n\n4. x\n\n5. y\n\nT";
    expect(hunkDiff(authored, returned)).toEqual([
      { before: ["7. x", "8. y"], after: ["4. x", "", "5. y"] },
    ]);
  });

  it("joins a deletion to the change before it", () => {
    expect(hunkDiff("a\nX\n\nb\n\nT", "a\nY\n\nT")).toEqual([
      { before: ["X", "", "b"], after: ["Y"] },
    ]);
  });

  it("joins an insertion to the change after it", () => {
    expect(hunkDiff("T\n\nX\nz", "T\n\nb\n\nY\nz")).toEqual([
      { before: ["X"], after: ["b", "", "Y"] },
    ]);
  });

  it("leaves a run where it is when sliding would not reach another change", () => {
    expect(hunkDiff("a\n\nb", "a\n\n\nb")).toEqual([{ before: [], after: [""] }]);
    expect(hunkDiff("a\nb\nc\nd", "a\nX\nb\nc\nd")).toEqual([{ before: [], after: ["X"] }]);
  });

  it("keeps separate changes separate when no identical line links them", () => {
    expect(hunkDiff("a\nb\nc\nd\ne", "a\nX\nc\nY\ne")).toEqual([
      { before: ["b"], after: ["X"] },
      { before: ["d"], after: ["Y"] },
    ]);
  });
});
