// @vitest-environment node
// WI-RA10A.2 — the composition anchor is a position in a DOCUMENT: it moves
// with the transactions that change that document, by the rule for whoever
// wrote them, and it is never answered for a document it does not belong to.
import { describe, it, expect } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { createCompositionAnchor } from "../compositionAnchor";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: { inline: true },
  },
});

const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const doc = (...blocks: PMNode[]) => schema.node("doc", null, blocks);
const stateOf = (document: PMNode) => EditorState.create({ schema, doc: document });

/** Who a transaction claims to be from. */
type Origin = "unmarked" | "composition" | "input" | "programmatic" | "load";

function mark(tr: Transaction, origin: Origin): Transaction {
  switch (origin) {
    case "composition":
      return tr.setMeta("composition", 7);
    case "input":
      return tr.setMeta("uiEvent", "input");
    case "programmatic":
      return tr.setMeta("addToHistory", true);
    case "load":
      return tr.setMeta("addToHistory", false).setMeta("preventUpdate", true);
    case "unmarked":
      return tr;
  }
}

const ALL_ORIGINS: Origin[] = ["unmarked", "composition", "input", "programmatic", "load"];

/** "hello world" in one paragraph: text occupies positions 1..12. */
function setup(anchorPos: number) {
  const state = stateOf(doc(p("hello world")));
  const anchor = createCompositionAnchor();
  anchor.begin(state.doc, anchorPos);
  return { state, anchor };
}

describe("an anchor belongs to the document it was read from", () => {
  it("answers null before any composition has begun", () => {
    const anchor = createCompositionAnchor();
    expect(anchor.at(doc(p("x")))).toBeNull();
    expect(anchor.current()).toBeNull();
  });

  it("answers the start position for the document it began in", () => {
    const { state, anchor } = setup(7);
    expect(anchor.at(state.doc)).toBe(7);
  });

  it("answers null for an equal but different document", () => {
    const { anchor } = setup(7);
    expect(anchor.at(doc(p("hello world")))).toBeNull();
  });

  it("answers null for the result of a transaction it was not shown", () => {
    const { state, anchor } = setup(7);
    const unseen = state.tr.insertText("x", 1);
    expect(anchor.at(unseen.doc)).toBeNull();
  });

  it("ignores a transaction built on a document it does not know", () => {
    const { anchor } = setup(7);
    const elsewhere = stateOf(doc(p("hello world"))).tr.insertText("x", 1);
    anchor.follow(elsewhere);
    expect(anchor.at(elsewhere.doc)).toBeNull();
  });

  it("is unchanged by a transaction that does not change the document", () => {
    const { state, anchor } = setup(7);
    const moveCursor = state.tr.setSelection(TextSelection.create(state.doc, 3));
    anchor.follow(moveCursor);
    expect(anchor.at(moveCursor.doc)).toBe(7);
  });
});

describe("a change that does not touch the anchor moves it like any position", () => {
  it.each(ALL_ORIGINS)("an insertion before it shifts it (%s)", (origin) => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.insertText("abc", 1), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(10);
  });

  it.each(ALL_ORIGINS)("an insertion after it leaves it (%s)", (origin) => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.insertText("abc", 9), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(7);
  });

  it.each(ALL_ORIGINS)("a deletion before it shifts it back (%s)", (origin) => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.delete(1, 4), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(4);
  });

  it.each(ALL_ORIGINS)("a deletion that ends at it moves it to where the deletion began (%s)", (origin) => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.delete(3, 7), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(3);
  });

  it.each(ALL_ORIGINS)("a replacement that starts at it leaves it in front (%s)", (origin) => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.insertText("WORLD!", 7, 12), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(7);
  });

  it("counts supplementary-plane characters as two positions", () => {
    const state = stateOf(doc(p("\u{20BB7}\u{1F600}ab")));
    const anchor = createCompositionAnchor();
    anchor.begin(state.doc, 5);
    const tr = state.tr.insertText("\u{1F600}", 1);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(7);
  });
});

describe("text inserted exactly at the anchor", () => {
  it.each<[Origin, number]>([
    ["composition", 7],
    ["input", 7],
    ["unmarked", 7],
    ["programmatic", 10],
    ["load", 10],
  ])("%s: the anchor is then at %i", (origin, expected) => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.insertText("abc", 7), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(expected);
  });

  it("treats an explicit addToHistory of false as programmatic too", () => {
    const { state, anchor } = setup(7);
    const tr = state.tr.insertText("abc", 7).setMeta("addToHistory", false);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(10);
  });

  it("does not treat preventUpdate: false as a marker", () => {
    const { state, anchor } = setup(7);
    const tr = state.tr.insertText("abc", 7).setMeta("preventUpdate", false);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(7);
  });

  it("lets the programmatic marker win over a composition tag", () => {
    const { state, anchor } = setup(7);
    const tr = state.tr.insertText("abc", 7).setMeta("composition", 7).setMeta("addToHistory", true);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(10);
  });
});

describe("text replaced on both sides of the anchor", () => {
  it.each<Origin>(["programmatic", "load", "unmarked"])("%s: the anchor is retired", (origin) => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.insertText("X", 4, 10), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBeNull();
  });

  it.each<Origin>(["composition", "input"])("%s: the anchor keeps its offset in the rewritten range", (origin) => {
    const { state, anchor } = setup(7);
    // [4, 10) becomes six other characters: offset 3 inside it is still 7.
    const tr = mark(state.tr.insertText("ABCDEF", 4, 10), origin);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(7);
  });

  it("clamps that offset when the composition's rewrite is shorter", () => {
    const { state, anchor } = setup(7);
    const tr = mark(state.tr.insertText("A", 4, 10), "composition");
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(5);
  });

  it("retires it when a load replaces the whole document", () => {
    const { state, anchor } = setup(7);
    const next = doc(p("something else entirely"));
    const tr = mark(state.tr.replaceWith(0, state.doc.content.size, next.content), "load");
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBeNull();
  });

  it("stays retired through every later transaction", () => {
    const { state, anchor } = setup(7);
    const load = mark(state.tr.insertText("X", 4, 10), "load");
    anchor.follow(load);
    const later = state.apply(load).tr.insertText("typed", 1);
    anchor.follow(later);
    expect(anchor.at(later.doc)).toBeNull();
    // The document it began in still has its answer.
    expect(anchor.at(state.doc)).toBe(7);
  });
});

describe("following a chain of transactions", () => {
  it("carries the anchor from each document to the next", () => {
    const { state, anchor } = setup(7);
    const first = state.tr.insertText("ab", 1);
    anchor.follow(first);
    const second = state.apply(first).tr.insertText("cde", 1);
    anchor.follow(second);
    const third = mark(state.apply(first).apply(second).tr.insertText("zz", 12), "programmatic");
    anchor.follow(third);

    expect(anchor.at(first.doc)).toBe(9);
    expect(anchor.at(second.doc)).toBe(12);
    expect(anchor.at(third.doc)).toBe(14);
  });

  it("maps through every step of a multi-step transaction", () => {
    const { state, anchor } = setup(7);
    const tr = state.tr.insertText("ab", 1).insertText("cd", 1).delete(1, 2);
    anchor.follow(tr);
    expect(anchor.at(tr.doc)).toBe(10);
  });

  it("keeps separate answers for two transactions built on the same document", () => {
    const { state, anchor } = setup(7);
    const one = state.tr.insertText("a", 1);
    const other = state.tr.insertText("abcd", 1);
    anchor.follow(one);
    anchor.follow(other);
    expect(anchor.at(one.doc)).toBe(8);
    expect(anchor.at(other.doc)).toBe(11);
  });
});

describe("the lifetime of a composition", () => {
  it("forgets everything on end", () => {
    const { state, anchor } = setup(7);
    const tr = state.tr.insertText("ab", 1);
    anchor.follow(tr);
    anchor.end();

    expect(anchor.at(state.doc)).toBeNull();
    expect(anchor.at(tr.doc)).toBeNull();
    expect(anchor.current()).toBeNull();
  });

  it("follows nothing once ended", () => {
    const { state, anchor } = setup(7);
    anchor.end();
    const tr = state.tr.insertText("ab", 1);
    expect(() => anchor.follow(tr)).not.toThrow();
    expect(anchor.at(tr.doc)).toBeNull();
  });

  it("starts the next composition clean, even in the same document", () => {
    const { state, anchor } = setup(7);
    const tr = state.tr.insertText("ab", 1);
    anchor.follow(tr);
    const first = anchor.current();

    anchor.begin(state.doc, 3);

    expect(anchor.current()).not.toBe(first);
    expect(anchor.at(state.doc)).toBe(3);
    // What the previous composition learned does not leak into this one.
    expect(anchor.at(tr.doc)).toBeNull();
  });

  it("gives each composition its own identity", () => {
    const anchor = createCompositionAnchor();
    const state = stateOf(doc(p("x")));
    anchor.begin(state.doc, 1);
    const first = anchor.current();
    anchor.begin(state.doc, 1);
    expect(anchor.current()).not.toBeNull();
    expect(anchor.current()).not.toBe(first);
  });
});
