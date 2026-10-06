// @vitest-environment node
// WI-RA10B.3 — the Source-mode cursor snapshot does not cost a pass over the
// document, on a keystroke or on a cursor move.
/**
 * Files of 1 MB and more are forced into Source mode, where the snapshot runs
 * on every keystroke and every cursor move. It used to join the whole document
 * into one string, split it into lines and test each line up to the cursor, so
 * a keystroke at the end of a large file cost a pass over all of it.
 *
 * Asserts a GROWTH EXPONENT, never a duration (`@/test/cpuClock`): the cost of
 * one snapshot at the end of a document 16 times longer. A pass over the
 * document is an exponent of 1; a lookup is an exponent near 0.
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { getCursorInfoFromCodeMirror } from "./codemirror";
import { sourceFenceIndex } from "./fenceIndex";

/** Linear is 1. A lookup that grows with the logarithm of the size stays far below this. */
const MAX_EXPONENT = 0.5;
const SMALL_LINES = 4_000;
const LARGE_LINES = 64_000;

/** Prose with a fenced block every 50 lines, and the cursor's line at the end. */
function documentOf(lines: number, lastLine: string): string {
  const out: string[] = [];
  for (let i = 0; out.length < lines - 1; i += 1) {
    if (i % 50 === 10) out.push("```ts", "const value = 1;", "```");
    else out.push(`Line ${i} of ordinary prose with a few words in it.`);
  }
  return [...out.slice(0, lines - 1), lastLine].join("\n");
}

function stateAtEnd(lines: number, lastLine: string): EditorState {
  const doc = documentOf(lines, lastLine);
  return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [sourceFenceIndex] });
}

/** The snapshot reads only `view.state`. */
const snapshot = (state: EditorState) => getCursorInfoFromCodeMirror({ state } as EditorView);

describe("Source-mode cursor snapshot — cost against document size", () => {
  it.each([
    { name: "in a paragraph", lastLine: "the last line of prose" },
    { name: "in a table row", lastLine: "| a | b |\n| --- | --- |\n| one | two |" },
    { name: "in an open code block", lastLine: "```\nconst last = true;" },
  ])("a cursor move $name costs the same at 16 times the size", ({ lastLine }) => {
    const small = stateAtEnd(SMALL_LINES, lastLine);
    const large = stateAtEnd(LARGE_LINES, lastLine);
    expect(snapshot(large).sourceLine).toBe(large.doc.lines);

    const growth = measureGrowth(snapshot, small, large);
    expect(growthExponent(growth, SMALL_LINES, LARGE_LINES)).toBeLessThan(MAX_EXPONENT);
  });

  it.each([
    { name: "a character typed at the end", at: (state: EditorState) => state.doc.length, insert: "x" },
    // Every fence below moves down a line.
    { name: "a new line at the top", at: () => 0, insert: "\n" },
  ])("$name costs the same at 16 times the size", ({ at, insert }) => {
    const keystroke = (state: EditorState) => {
      const from = at(state);
      const typed = state.update({ changes: { from, insert }, selection: { anchor: from + 1 } }).state;
      snapshot(typed);
    };
    const small = stateAtEnd(SMALL_LINES, "the last line of prose");
    const large = stateAtEnd(LARGE_LINES, "the last line of prose");

    const growth = measureGrowth(keystroke, small, large);
    expect(growthExponent(growth, SMALL_LINES, LARGE_LINES)).toBeLessThan(MAX_EXPONENT);
  });
});
