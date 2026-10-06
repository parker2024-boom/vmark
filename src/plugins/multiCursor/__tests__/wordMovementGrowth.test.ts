// @vitest-environment node
// WI-RA24.10 — moving N cursors by a word costs about linearly in N when the
// paragraph grows with the cursors.
//
// "Select all occurrences" in a long paragraph puts one cursor per word, so
// the paragraph and the cursor count grow together. Word movement read the
// paragraph's text and segmented all of it once PER CURSOR — N cursors × a
// paragraph of N words — which is quadratic. Timed on the test thread's CPU
// clock (`measureGrowth`) from 50 to 500 words-and-cursors; the exponent must
// stay below 1.5 (segmenting once and searching the segments per cursor is
// about N log N, ~1.2 over this range; per-cursor segmentation reads ~2).
import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, SelectionRange, TextSelection } from "@tiptap/pm/state";
import { MultiSelection } from "@/plugins/shared/MultiSelection";
import { measureGrowth, growthExponent } from "@/test/cpuClock";
import { handleMultiCursorHorizontal } from "../horizontalMovement";

const SMALL = 50;
const LARGE = 500;
const MAX_EXPONENT = 1.5;

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
});

const WORD = "词ab ";

/** One paragraph of `count` words with a cursor at the start of each word. */
function cursorPerWord(count: number): EditorState {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(WORD.repeat(count))])]);
  const base = EditorState.create({ doc, schema, selection: TextSelection.atStart(doc) });
  const ranges = Array.from({ length: count }, (_, i) => {
    const $pos = doc.resolve(1 + i * WORD.length);
    return new SelectionRange($pos, $pos);
  });
  return base.apply(base.tr.setSelection(new MultiSelection(ranges, count - 1)));
}

/** Where each cursor lands, as offsets in the paragraph. */
function heads(state: EditorState, direction: "ArrowLeft" | "ArrowRight"): number[] {
  const tr = handleMultiCursorHorizontal(state, direction, false, "word");
  if (!tr) throw new Error("word movement declined");
  return tr.selection.ranges.map((r) => r.$from.pos - 1);
}

describe("word movement at a cursor per word", () => {
  it("still lands each cursor on its own word's edge", () => {
    const state = cursorPerWord(4);
    // Intl.Segmenter splits 词 from ab: right stops at the end of 词, left at the start of the ab before.
    expect(heads(state, "ArrowRight")).toEqual([1, 5, 9, 13]);
    expect(heads(cursorPerWord(4), "ArrowLeft")).toEqual([0, 1, 5, 9]);
  });

  it.each(["ArrowRight", "ArrowLeft"] as const)("%s grows about linearly with the cursors", (direction) => {
    const growth = measureGrowth(
      (state) => void handleMultiCursorHorizontal(state, direction, false, "word"),
      cursorPerWord(SMALL),
      cursorPerWord(LARGE),
    );
    expect(growthExponent(growth, SMALL, LARGE)).toBeLessThan(MAX_EXPONENT);
  });
});
