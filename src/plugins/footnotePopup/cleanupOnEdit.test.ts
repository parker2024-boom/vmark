// WI-RA10B.6 — footnote cleanup does not walk the document for an edit that
// cannot have removed a footnote reference, and still cleans up after every
// edit that did.
import { describe, it, expect, vi } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Plugin, type Transaction } from "@tiptap/pm/state";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
vi.mock("./footnote-popup.css", () => ({}));

import { footnotePopupExtension } from "./tiptap";
import {
  collectFootnoteNodes,
  createCleanupAndRenumberTransaction,
  createRenumberTransaction,
  hasRefCountDropped,
} from "./tiptapCleanup";

const schema = new Schema({
  nodes: {
    doc: { content: "(block | footnote_definition)+" },
    paragraph: { group: "block", content: "inline*" },
    footnote_reference: { group: "inline", inline: true, atom: true, attrs: { label: { default: "1" } } },
    footnote_definition: { content: "block+", attrs: { label: { default: "1" } } },
    text: { group: "inline" },
  },
});

const p = (text: string, ...refs: string[]): PMNode =>
  schema.node("paragraph", null, [
    ...(text ? [schema.text(text)] : []),
    ...refs.map((label) => schema.node("footnote_reference", { label })),
  ]);
const def = (label: string): PMNode => schema.node("footnote_definition", { label }, [p(`Note ${label}`)]);
const docOf = (...children: PMNode[]): PMNode => schema.node("doc", null, children);

type Append = (transactions: readonly Transaction[], before: EditorState, after: EditorState) => Transaction | null | undefined;

/** A fresh plugin instance: its cleanup carries state between calls, as one editor's does. */
function freshCleanup(): Append {
  const store = { getState: () => ({ isOpen: false, openPopup: vi.fn(), closePopup: vi.fn() }), subscribe: () => () => {} };
  const context = { name: footnotePopupExtension.name, options: { store }, storage: footnotePopupExtension.storage };
  const plugins = footnotePopupExtension.config.addProseMirrorPlugins?.call(context as never) ?? [];
  const plugin = plugins[0] as Plugin;
  return (transactions, before, after) => plugin.spec.appendTransaction!.call(plugin, transactions, before, after);
}

/** The cleanup rule with no shortcut: read both documents in full, every time. */
function cleanupByFullScan(before: EditorState, after: EditorState): Transaction | null {
  const refType = schema.nodes.footnote_reference;
  const defType = schema.nodes.footnote_definition;
  const collected = collectFootnoteNodes(after.doc);
  if (collected.refs.length === 0 && collected.defs.length === 0) return null;
  if (!hasRefCountDropped(collectFootnoteNodes(before.doc).refs, collected.refs)) return null;
  const orphaned = collected.defs.filter((d) => !collected.refLabels.has(d.label));
  if (orphaned.length === 0 && collected.refLabels.size === 0) {
    if (collected.defs.length === 0) return null;
    let tr = after.tr;
    for (const d of [...collected.defs].sort((a, b) => b.pos - a.pos)) tr = tr.delete(d.pos, d.pos + d.size);
    return tr;
  }
  if (orphaned.length === 0) return createRenumberTransaction(after, refType, defType, collected);
  return createCleanupAndRenumberTransaction(after, collected.refLabels, refType, defType, collected);
}

const outcome = (tr: Transaction | null | undefined): string | null => (tr ? tr.doc.toString() : null);

describe("footnote cleanup — cost of an edit that removes no reference", () => {
  const SMALL = 1_000;
  const LARGE = 16_000;

  /** `paragraphs` of prose, with footnotes at the start so a scan cannot stop early. */
  function typedAtEnd(paragraphs: number, change: (state: EditorState) => Transaction) {
    const body = Array.from({ length: paragraphs }, (_, i) => p(`Paragraph ${i} of prose.`));
    const state = EditorState.create({ schema, doc: docOf(p("Intro", "1", "2"), ...body, def("1"), def("2")) });
    const tr = change(state);
    return { state, tr, after: state.apply(tr) };
  }

  /** Where the last body paragraph's text ends. */
  const endOfBody = (state: EditorState): number => {
    let pos = 0;
    state.doc.forEach((node, offset) => {
      if (node.type.name === "paragraph") pos = offset + node.nodeSize - 1;
    });
    return pos;
  };

  it.each([
    { name: "a typed character", change: (s: EditorState) => s.tr.insertText("x", endOfBody(s)) },
    { name: "a deleted character", change: (s: EditorState) => s.tr.delete(endOfBody(s) - 1, endOfBody(s)) },
  ])("$name costs the same at 16 times the size", ({ change }) => {
    const small = typedAtEnd(SMALL, change);
    const large = typedAtEnd(LARGE, change);
    const cleanup = freshCleanup();
    expect(cleanup([large.tr], large.state, large.after)).toBeNull();

    const run = ({ state, tr, after }: typeof small) => {
      cleanup([tr], state, after);
    };
    const growth = measureGrowth(run, small, large);
    // Reading the document is an exponent of 1; reading the step is 0.
    expect(growthExponent(growth, SMALL, LARGE)).toBeLessThan(0.5);
  });
});

describe("footnote cleanup — every edit that removes a reference is still cleaned up", () => {
  const start = () =>
    EditorState.create({
      schema,
      doc: docOf(p("Alpha", "1"), p("Beta", "2", "1"), p("中文", "3"), p("Plain"), def("1"), def("2"), def("3")),
    });

  const positionsOf = (state: EditorState, typeName: string): number[] => {
    const found: number[] = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name === typeName) found.push(pos);
    });
    return found;
  };

  it.each([
    { name: "deleting a reference", edit: (s: EditorState) => s.tr.delete(6, 7) },
    { name: "deleting one of two references to a footnote", edit: (s: EditorState) => s.tr.delete(14, 15) },
    { name: "replacing a paragraph that holds one", edit: (s: EditorState) => s.tr.replaceWith(0, 8, p("New")) },
    { name: "relabelling a reference in place", edit: (s: EditorState) => s.tr.setNodeAttribute(6, "label", "9") },
    { name: "retyping a reference node", edit: (s: EditorState) => s.tr.setNodeMarkup(6, null, { label: "9" }) },
    { name: "typing text", edit: (s: EditorState) => s.tr.insertText("x", 2) },
    { name: "inserting a new reference", edit: (s: EditorState) => s.tr.insert(2, schema.node("footnote_reference", { label: "7" })) },
    { name: "deleting text beside a reference", edit: (s: EditorState) => s.tr.delete(2, 4) },
    { name: "deleting a definition", edit: (s: EditorState) => s.tr.delete(positionsOf(s, "footnote_definition")[0], positionsOf(s, "footnote_definition")[1]) },
  ])("$name gives the full scan's result", ({ edit }) => {
    const state = start();
    expect(positionsOf(state, "footnote_reference")).toEqual([6, 13, 14, 19]);
    const tr = edit(state);
    const after = state.apply(tr);
    expect(outcome(freshCleanup()([tr], state, after))).toBe(outcome(cleanupByFullScan(state, after)));
  });

  it("agrees with the full scan through 2,000 random edits on one editor", () => {
    // A fixed-seed generator: the same edits every run, so a failure reproduces.
    let seed = 0x7a31c5;
    const random = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return bound <= 0 ? 0 : seed % bound;
    };

    /** One random edit appended to `tr`; an edit the document cannot take is skipped. */
    const edit = (tr: Transaction): void => {
      const size = tr.doc.content.size;
      const at = random(size + 1);
      const to = Math.min(size, at + random(6));
      try {
        switch (random(7)) {
          case 0:
            tr.insertText("x", at);
            break;
          case 1:
            tr.delete(at, to);
            break;
          case 2:
            tr.insert(at, schema.node("footnote_reference", { label: String(1 + random(4)) }));
            break;
          case 3:
            tr.replaceWith(at, to, p("New", String(1 + random(4))));
            break;
          case 4: {
            const node = tr.doc.nodeAt(at);
            if (node?.type.name === "footnote_reference") tr.setNodeAttribute(at, "label", String(1 + random(4)));
            break;
          }
          case 5:
            tr.split(at);
            break;
          default:
            tr.insert(tr.doc.content.size, def(String(1 + random(4))));
        }
      } catch {
        // Not a valid edit at this position; the transaction is unchanged.
      }
    };

    let cleanup = freshCleanup();
    let state = start();
    let cleaned = 0;
    for (let step = 0; step < 2000; step += 1) {
      const before = state;
      const batch: Transaction[] = [];
      for (let t = 0, count = 1 + random(2); t < count; t += 1) {
        const tr = state.tr;
        for (let e = 0, edits = 1 + random(2); e < edits; e += 1) edit(tr);
        batch.push(tr);
        state = state.apply(tr);
      }
      const expected = batch.some((tr) => tr.docChanged) ? cleanupByFullScan(before, state) : null;
      const actual = cleanup(batch, before, state);
      if (outcome(actual) !== outcome(expected)) {
        throw new Error(`step ${step}: cleanup gave ${outcome(actual)}, full scan ${outcome(expected)} for ${state.doc.toString()}`);
      }
      if (expected) {
        cleaned += 1;
        state = state.apply(expected);
      }
      if (state.doc.content.size > 400 || state.doc.content.size < 20) {
        state = start();
        cleanup = freshCleanup();
      }
    }
    // The run must have exercised the cleanup, not only edits that need none.
    expect(cleaned).toBeGreaterThan(50);
  });
});
