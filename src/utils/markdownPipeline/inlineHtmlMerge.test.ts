// @vitest-environment node
// WI-RA2.3 — an inline HTML pair (`<kbd>…</kbd>`) is merged into one node only
// when the merged text reads back as the same content, and without rewriting
// characters that need no escaping.
import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "./adapter";
import { getProductionSchema } from "@/test/productionSchema";

const schema = getProductionSchema();
const roundTrip = (markdown: string): string =>
  serializeMarkdown(schema, parseMarkdown(schema, markdown));

/** The values of every inline HTML node in a document, in order. */
function inlineHtml(doc: PMNode): string[] {
  const values: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "html_inline") values.push(String(node.attrs.value));
  });
  return values;
}

function count(doc: PMNode, predicate: (node: PMNode) => boolean): number {
  let n = 0;
  doc.descendants((node) => {
    if (predicate(node)) n += 1;
  });
  return n;
}

describe("inline HTML pairs — what is written back", () => {
  it.each([
    ["an apostrophe", "a <span title='x'>it's</span> b\n"],
    ["a double quote", 'a <kbd>"q"</kbd> b\n'],
    ["a greater-than sign", "a <kbd>x > y</kbd> b\n"],
    ["an ampersand that is not a reference", "a <kbd>a & b</kbd> and <kbd>AT&T</kbd>\n"],
    ["plain words", "Press <kbd>Ctrl</kbd> then <kbd>Enter</kbd>\n"],
    ["CJK text", "按 <kbd>回车</kbd> 键\n"],
    ["a nested pair", "a <b><i>x</i></b> b\n"],
    ["an empty pair", "a <span></span> b\n"],
  ])("leaves %s as written", (_label, source) => {
    expect(roundTrip(source)).toBe(source);
    expect(roundTrip(roundTrip(source))).toBe(source);
  });

  it("keeps a character reference that is literal text", () => {
    // `&amp;amp;` is the text `&amp;`. Written back raw it would read as `&`.
    const source = "a <kbd>&amp;amp;</kbd> b\n";
    const before = parseMarkdown(schema, source);
    const after = parseMarkdown(schema, roundTrip(source));
    expect(after.textContent).toBe(before.textContent);
    expect(inlineHtml(after)).toEqual(inlineHtml(before));
  });
});

describe("inline HTML pairs — content that cannot be merged", () => {
  it.each([
    ["escaped emphasis markers", "a <kbd>\\*x\\*</kbd> b\n"],
    ["an escaped backtick pair", "a <kbd>\\`x\\`</kbd> b\n"],
    ["an escaped link", "a <kbd>\\[x](u)</kbd> b\n"],
    ["escaped highlight markers", "a <kbd>\\==x\\==</kbd> b\n"],
  ])("keeps %s literal across two saves", (_label, source) => {
    const before = parseMarkdown(schema, source);
    const once = roundTrip(source);
    const twice = roundTrip(once);
    const after = parseMarkdown(schema, twice);
    expect(after.textContent).toBe(before.textContent);
    expect(count(after, (node) => node.marks.length > 0)).toBe(0);
    expect(twice).toBe(once);
  });

  it.each([
    ["a backslash break", "a <b>x\\\ny</b> z\n"],
    ["a two-space break", "a <b>x  \ny</b> z\n"],
  ])("keeps %s inside a pair a hard break across two saves", (_label, source) => {
    const before = parseMarkdown(schema, source);
    expect(count(before, (node) => node.type.name === "hardBreak")).toBe(1);
    const once = roundTrip(source);
    const twice = roundTrip(once);
    const after = parseMarkdown(schema, twice);
    expect(count(after, (node) => node.type.name === "hardBreak")).toBe(1);
    expect(after.textContent).toBe(before.textContent);
    expect(twice).not.toContain("&lt;");
    expect(twice).toBe(once);
  });
});

describe("inline HTML pairs — still merged where that is exact", () => {
  it.each([
    ["plain words", "Press <kbd>Ctrl</kbd> now\n", ["<kbd>Ctrl</kbd>"]],
    ["an apostrophe", "a <kbd>it's</kbd> b\n", ["<kbd>it's</kbd>"]],
    ["punctuation that starts nothing", "a <kbd>Ctrl+C, Ctrl-V.</kbd> b\n", ["<kbd>Ctrl+C, Ctrl-V.</kbd>"]],
    ["a single marker character", "a <kbd>*</kbd> and <kbd>_</kbd> b\n", ["<kbd>*</kbd>", "<kbd>_</kbd>"]],
    ["a nested pair", "a <b><i>x</i></b> b\n", ["<b><i>x</i></b>"]],
  ])("merges %s into one node", (_label, source, expected) => {
    expect(inlineHtml(parseMarkdown(schema, source))).toEqual(expected);
  });
});

describe("inline HTML in a table cell", () => {
  it.each([
    ["a pair holding a pipe", "| a |\n| --- |\n| <kbd>\\|</kbd> |\n"],
    ["an attribute holding a pipe", '| a |\n| --- |\n| <span title="x\\|y">z</span> |\n'],
  ])("keeps %s in its cell", (_label, source) => {
    const before = parseMarkdown(schema, source);
    const once = roundTrip(source);
    const after = parseMarkdown(schema, once);
    const cells = (doc: PMNode) =>
      count(doc, (node) => node.type.name === "tableCell" || node.type.name === "tableHeader");
    expect(cells(after)).toBe(cells(before));
    expect(after.textContent).toBe(before.textContent);
    expect(inlineHtml(after)).toEqual(inlineHtml(before));
    expect(roundTrip(once)).toBe(once);
  });
});
