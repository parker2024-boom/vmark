/**
 * Document fixtures for the Tiptap cursor-sync tests: a schema with the block
 * types cursor sync distinguishes (paragraph, heading, code block, blockquote,
 * table), builders for them, and a view stand-in that records dispatches.
 *
 * @coordinates-with utils/cursorSync/tiptap.test.ts — the tests built on these
 * @module utils/cursorSync/__tests__/tiptapFixtures
 */
import { vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";

// Schema with sourceLine support
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      attrs: { sourceLine: { default: null } },
      parseDOM: [{ tag: "p" }],
      toDOM() {
        return ["p", 0];
      },
    },
    heading: {
      content: "text*",
      group: "block",
      attrs: { sourceLine: { default: null }, level: { default: 1 } },
      parseDOM: [{ tag: "h1" }],
      toDOM() {
        return ["h1", 0];
      },
    },
    codeBlock: {
      content: "text*",
      group: "block",
      code: true,
      attrs: { sourceLine: { default: null }, language: { default: null } },
      parseDOM: [{ tag: "pre" }],
      toDOM() {
        return ["pre", 0];
      },
    },
    blockquote: {
      content: "block+",
      group: "block",
      attrs: { sourceLine: { default: null } },
      parseDOM: [{ tag: "blockquote" }],
      toDOM() {
        return ["blockquote", 0];
      },
    },
    table: {
      content: "tableRow+",
      group: "block",
      attrs: { sourceLine: { default: null } },
      toDOM() {
        return ["table", ["tbody", 0]];
      },
    },
    tableRow: {
      content: "(tableHeader | tableCell)+",
      toDOM() {
        return ["tr", 0];
      },
    },
    tableHeader: {
      content: "paragraph+",
      toDOM() {
        return ["th", 0];
      },
    },
    tableCell: {
      content: "paragraph+",
      toDOM() {
        return ["td", 0];
      },
    },
    text: { inline: true },
  },
});

export function para(text: string, sourceLine: number | null = null) {
  const content = text ? [schema.text(text)] : [];
  return schema.node("paragraph", { sourceLine }, content);
}

export function heading(text: string, sourceLine: number | null = null) {
  const content = text ? [schema.text(text)] : [];
  return schema.node("heading", { sourceLine, level: 1 }, content);
}

export function codeBlock(text: string, sourceLine: number | null = null) {
  const content = text ? [schema.text(text)] : [];
  return schema.node("codeBlock", { sourceLine }, content);
}

/** A table whose rows are arrays of cell texts; row 0 is the header row. */
export function table(rows: string[][], sourceLine: number | null = null) {
  return schema.node(
    "table",
    { sourceLine },
    rows.map((cells, r) =>
      schema.node(
        "tableRow",
        null,
        cells.map((text) => schema.node(r === 0 ? "tableHeader" : "tableCell", null, [para(text)])),
      ),
    ),
  );
}

export function createState(doc: ReturnType<typeof schema.node>, pos?: number) {
  const state = EditorState.create({ doc, schema });
  if (pos !== undefined) {
    const clampedPos = Math.min(pos, doc.content.size);
    return state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, clampedPos))
    );
  }
  return state;
}

export function createMockView(state: EditorState) {
  const dispatchedTrs: Transaction[] = [];
  return {
    state,
    dispatch: vi.fn((tr: Transaction) => {
      dispatchedTrs.push(tr);
    }),
    _dispatched: dispatchedTrs,
  };
}
