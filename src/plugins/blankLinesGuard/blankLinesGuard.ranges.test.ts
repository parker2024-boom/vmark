// @vitest-environment node
// WI-RA10B.5 — the guard inspects only what a transaction changed: nothing for
// a typed character, and the same blocks as a walk of the whole document for
// every structural edit.
import { describe, it, expect } from "vitest";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { AttrStep, findWrapping, liftTarget } from "@tiptap/pm/transform";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { blankLinesGuard } from "./blankLinesGuard";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { attrs: { blankLinesBefore: { default: null } }, content: "inline*", group: "block" },
    blockquote: { attrs: { blankLinesBefore: { default: null } }, content: "block+", group: "block" },
    text: { group: "inline" },
  },
});

const para = (text: string, blank: number | null = 1): PMNode =>
  schema.node("paragraph", { blankLinesBefore: blank }, text ? [schema.text(text)] : []);
const quote = (...children: PMNode[]): PMNode => schema.node("blockquote", { blankLinesBefore: 2 }, children);

const guard = blankLinesGuard();

/** Positions the guard resets for a batch of transactions that led from `before` to `after`. */
function resetByGuard(transactions: Transaction[], before: EditorState, after: EditorState): number[] {
  const appended = guard.spec.appendTransaction!.call(guard, transactions, before, after);
  if (!appended) return [];
  return appended.steps.map((step) => (step as AttrStep).pos).sort((a, b) => a - b);
}

/**
 * The rule, applied the slow way: map every step's changed range to the final
 * document, then test every block of that document against every range.
 */
function resetByFullWalk(transactions: Transaction[], after: EditorState): number[] {
  const ranges: Array<{ from: number; to: number }> = [];
  transactions.forEach((transaction, ti) => {
    transaction.mapping.maps.forEach((map, mi) => {
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        const rest = transaction.mapping.slice(mi + 1);
        let from = rest.map(newStart, -1);
        let to = rest.map(newEnd, 1);
        for (let tj = ti + 1; tj < transactions.length; tj += 1) {
          from = transactions[tj].mapping.map(from, -1);
          to = transactions[tj].mapping.map(to, 1);
        }
        ranges.push({ from, to });
      });
    });
  });
  const reset: number[] = [];
  after.doc.descendants((node, pos) => {
    if (!node.isBlock || node.attrs.blankLinesBefore == null) return;
    const end = pos + node.nodeSize;
    if (ranges.some((r) => (pos > r.from && pos < r.to) || (pos >= r.from && end <= r.to))) reset.push(pos);
  });
  return reset;
}

describe("blankLinesGuard — what a transaction changed", () => {
  it("inspects nothing for a typed character, however large the document", () => {
    const stateOf = (paragraphs: number) =>
      EditorState.create({
        schema,
        doc: schema.node("doc", null, Array.from({ length: paragraphs }, (_, i) => para(`Paragraph ${i} of prose.`))),
      });
    /** A character typed at the end of the last paragraph, and the states either side of it. */
    const typedAtEnd = (paragraphs: number) => {
      const state = stateOf(paragraphs);
      const tr = state.tr.insertText("x", state.doc.content.size - 1);
      return { state, tr, after: state.apply(tr) };
    };
    const SMALL = 1_000;
    const LARGE = 16_000;
    const small = typedAtEnd(SMALL);
    const large = typedAtEnd(LARGE);
    expect(large.after.doc.childCount).toBe(LARGE);
    expect(resetByGuard([large.tr], large.state, large.after)).toEqual([]);

    const run = ({ state, tr, after }: ReturnType<typeof typedAtEnd>) => {
      guard.spec.appendTransaction!.call(guard, [tr], state, after);
    };
    const growth = measureGrowth(run, small, large);
    // A walk of the document is an exponent of 1; reading the step is 0.
    expect(growthExponent(growth, SMALL, LARGE)).toBeLessThan(0.5);
  });

  it("resets the second half of a split inside a blockquote", () => {
    const state = EditorState.create({ schema, doc: schema.node("doc", null, [quote(para("Hello", 3)), para("after", 4)]) });
    const tr = state.tr.split(4);
    const after = state.apply(tr);
    expect(resetByGuard([tr], state, after)).toEqual(resetByFullWalk([tr], after));
    expect(resetByGuard([tr], state, after)).toHaveLength(1);
  });

  it("resets a block created by a later transaction of the batch inside text typed by an earlier one", () => {
    const state = EditorState.create({ schema, doc: schema.node("doc", null, [para("Hello", 3)]) });
    const typed = state.tr.insertText("abc", 6);
    const mid = state.apply(typed);
    const split = mid.tr.split(8);
    const after = mid.apply(split);
    expect(resetByGuard([typed, split], state, after)).toEqual(resetByFullWalk([typed, split], after));
    expect(resetByGuard([typed, split], state, after)).toHaveLength(1);
  });

  it("agrees with a walk of the whole document through 3,000 random edits", () => {
    // A fixed-seed generator: the same edits every run, so a failure reproduces.
    let seed = 0x51ed27;
    const random = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return bound <= 0 ? 0 : seed % bound;
    };
    const fresh = () =>
      EditorState.create({
        schema,
        doc: schema.node("doc", null, [
          para("Alpha", 3),
          quote(para("Beta", 1), quote(para("Gamma", 2)), para("", 4)),
          para("中文 delta", null),
          para("Epsilon", 5),
        ]),
      });

    /** One random edit appended to `tr`; an edit the document cannot take is skipped. */
    const edit = (tr: Transaction): void => {
      const size = tr.doc.content.size;
      const at = random(size + 1);
      const to = Math.min(size, at + random(12));
      try {
        switch (random(9)) {
          case 0:
            tr.insertText("x", at);
            break;
          case 1:
            tr.split(at, 1 + random(2));
            break;
          case 2:
            tr.delete(at, to);
            break;
          case 3:
            tr.insert(at, para("Pasted", 6));
            break;
          case 4:
            tr.replaceWith(at, to, [para("One", 7), quote(para("Two", 8))]);
            break;
          case 5:
            tr.join(at);
            break;
          case 6: {
            const range = tr.doc.resolve(at).blockRange(tr.doc.resolve(to));
            const wrapping = range && findWrapping(range, schema.nodes.blockquote, { blankLinesBefore: 9 });
            if (range && wrapping) tr.wrap(range, wrapping);
            break;
          }
          case 7: {
            const range = tr.doc.resolve(at).blockRange(tr.doc.resolve(to));
            const target = range && liftTarget(range);
            if (range && target != null) tr.lift(range, target);
            break;
          }
          default: {
            const node = tr.doc.nodeAt(at);
            if (node?.isBlock) tr.setNodeAttribute(at, "blankLinesBefore", 1 + random(5));
          }
        }
      } catch {
        // Not a valid edit at this position; the transaction is unchanged.
      }
    };

    let state = fresh();
    let structural = 0;
    for (let step = 0; step < 3000; step += 1) {
      const before = state;
      const batch: Transaction[] = [];
      for (let t = 0, count = 1 + random(2); t < count; t += 1) {
        const tr = state.tr;
        for (let e = 0, edits = 1 + random(3); e < edits; e += 1) edit(tr);
        batch.push(tr);
        state = state.apply(tr);
      }
      const expected = resetByFullWalk(batch, state);
      const actual = resetByGuard(batch, before, state);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `step ${step}: guard reset ${JSON.stringify(actual)}, full walk ${JSON.stringify(expected)} in ${state.doc.toString()}`,
        );
      }
      if (expected.length > 0) structural += 1;
      if (state.doc.content.size > 600) state = fresh();
    }
    // The run must have exercised the rule, not only edits that reset nothing.
    expect(structural).toBeGreaterThan(300);
  });
});
