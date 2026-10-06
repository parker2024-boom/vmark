// @vitest-environment node
// WI-RA23.1 — editing every range from the end gives exactly the transaction a
// plain loop over `state.tr` gives: the same steps, the same document, the
// same stored-mark use, and every range mapped where `tr.mapping` maps it.
//
// The plain loop re-mapped the whole multi-selection after every typed
// character and mapped every range through every step; `editRangesFromEnd`
// avoids both. These properties are the proof that it changes cost only.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Schema } from "@tiptap/pm/model";
import type { Mark, Node } from "@tiptap/pm/model";
import { EditorState, SelectionRange, TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { canSplit } from "@tiptap/pm/transform";
import { MultiSelection } from "@/plugins/shared/MultiSelection";
import { normalizeRangesWithPrimary } from "@/plugins/shared/rangeUtils";
import { editRangesFromEnd } from "../rangeEdits";
import type { RangeEdit } from "../rangeEdits";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
  marks: { bold: {} },
});
const bold = schema.marks.bold.create();

/** Paragraph texts mixing plain, bold and astral characters. */
const docArb = fc
  .array(
    fc.array(fc.constantFrom("a", "b", "😀", " ", "中"), { maxLength: 8 }).map((chars) => chars.join("")),
    { minLength: 1, maxLength: 3 },
  )
  .map((texts) =>
    schema.node(
      "doc",
      null,
      texts.map((text, i) =>
        schema.node("paragraph", null, text ? [schema.text(text, i % 2 ? [bold] : [])] : []),
      ),
    ),
  );

/** Merged, sorted ranges inside textblocks — what the multi-cursor handlers edit. */
function rangesArb(doc: Node): fc.Arbitrary<SelectionRange[]> {
  const max = doc.content.size - 1;
  return fc
    .array(fc.tuple(fc.integer({ min: 1, max }), fc.integer({ min: 0, max: 3 })), { minLength: 1, maxLength: 8 })
    .map((pairs) => {
      const ranges = pairs.map(([at, len]) => {
        const $from = doc.resolve(at);
        const to = Math.min(at + len, at + $from.parent.content.size - $from.parentOffset);
        return new SelectionRange($from, doc.resolve(to));
      });
      return normalizeRangesWithPrimary(ranges, doc, 0, true).ranges;
    });
}

const isCursor = (range: SelectionRange) => range.$from.pos === range.$to.pos;

const editArb: fc.Arbitrary<{ name: string; edit: RangeEdit }> = fc.oneof(
  fc.constantFrom("X", "", "😀", "ab").map((text) => ({
    name: `insert ${JSON.stringify(text)}`,
    edit: (tr: Transaction, range: SelectionRange) => tr.insertText(text, range.$from.pos, range.$to.pos),
  })),
  fc.constant({
    name: "delete",
    edit: (tr: Transaction, range: SelectionRange) =>
      isCursor(range) ? tr : tr.delete(range.$from.pos, range.$to.pos),
  }),
  fc.constant({
    name: "backspace one unit",
    edit: (tr: Transaction, range: SelectionRange) =>
      isCursor(range) && range.$from.parentOffset > 0 ? tr.delete(range.$from.pos - 1, range.$from.pos) : tr,
  }),
  fc.constant({
    name: "split",
    edit: (tr: Transaction, range: SelectionRange) => {
      if (!canSplit(tr.doc, range.$from.pos)) return tr;
      if (!isCursor(range)) tr.delete(range.$from.pos, range.$to.pos);
      return tr.split(range.$from.pos);
    },
  }),
);

function stateWith(doc: Node, ranges: SelectionRange[], storedMarks: readonly Mark[] | null): EditorState {
  return EditorState.create({
    doc,
    schema,
    selection: new MultiSelection(ranges, ranges.length - 1),
    storedMarks,
  });
}

/** The plain loop every handler used to run: last range first, ties in input order. */
function referenceEdits(state: EditorState, ranges: SelectionRange[], edit: RangeEdit): Transaction {
  let tr = state.tr;
  const descending = [...ranges].sort((a, b) => b.$from.pos - a.$from.pos);
  for (const range of descending) tr = edit(tr, range, ranges.indexOf(range));
  return tr;
}

describe("editRangesFromEnd", () => {
  it("builds the plain loop's transaction and maps every range as its mapping does", () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) =>
          fc.tuple(fc.constant(doc), rangesArb(doc), editArb, fc.constantFrom(null, [bold])),
        ),
        ([doc, ranges, { edit }, storedMarks]) => {
          const state = stateWith(doc, ranges, storedMarks);
          const reference = referenceEdits(state, ranges, edit);
          const { tr, map } = editRangesFromEnd(state, ranges, edit);

          expect(tr.doc.eq(reference.doc)).toBe(true);
          expect(tr.steps.map((step) => step.toJSON())).toEqual(reference.steps.map((step) => step.toJSON()));
          expect(tr.storedMarks).toEqual(reference.storedMarks);
          ranges.forEach((range, i) => {
            expect(map(i, range.$from.pos)).toBe(reference.mapping.map(range.$from.pos));
            expect(map(i, range.$to.pos)).toBe(reference.mapping.map(range.$to.pos));
          });
        },
      ),
      { numRuns: 500 },
    );
  });

  it("applies stored marks to the first edit, as a plain transaction does", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("abcd")])]);
    const ranges = [1, 3].map((pos) => new SelectionRange(doc.resolve(pos), doc.resolve(pos)));
    const state = stateWith(doc, ranges, [bold]);
    const insertX: RangeEdit = (tr, range) => tr.insertText("X", range.$from.pos, range.$to.pos);

    const { tr } = editRangesFromEnd(state, ranges, insertX);

    expect(tr.doc.eq(referenceEdits(state, ranges, insertX).doc)).toBe(true);
    expect(tr.doc.rangeHasMark(1, 6, schema.marks.bold)).toBe(true);
  });

  it("hands each edit its range's index in the input, last range first", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("abcdef")])]);
    const ranges = [3, 1, 5].map((pos) => new SelectionRange(doc.resolve(pos), doc.resolve(pos)));
    const state = EditorState.create({ doc, schema, selection: TextSelection.atStart(doc) });
    const seen: number[] = [];

    editRangesFromEnd(state, ranges, (tr, _range, index) => {
      seen.push(index);
      return tr;
    });

    expect(seen).toEqual([2, 0, 1]);
  });

  it("returns an unchanged document and identity mapping when no edit applies", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("ab")])]);
    const ranges = [new SelectionRange(doc.resolve(2), doc.resolve(2))];
    const state = stateWith(doc, ranges, null);

    const { tr, map } = editRangesFromEnd(state, ranges, (t) => t);

    expect(tr.docChanged).toBe(false);
    expect(map(0, 2)).toBe(2);
  });
});
