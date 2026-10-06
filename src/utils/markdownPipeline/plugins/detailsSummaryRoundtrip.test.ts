// @vitest-environment node
// WI-RA2.3 — a <details> summary keeps its formatting and its text across a
// save: marks are written back as the markdown they were read from, and
// characters that needed escaping are not escaped again on every save.
import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "../adapter";
import { getProductionSchema } from "@/test/productionSchema";

const schema = getProductionSchema();
const roundTrip = (markdown: string): string =>
  serializeMarkdown(schema, parseMarkdown(schema, markdown));

const details = (summary: string): string =>
  `<details>\n<summary>${summary}</summary>\n\nbody\n</details>\n`;

function summaryOf(doc: PMNode): PMNode {
  let found: PMNode | undefined;
  doc.descendants((node) => {
    if (node.type.name === "detailsSummary") found = node;
  });
  if (!found) throw new Error("no summary in document");
  return found;
}

const marksIn = (node: PMNode): string[] => {
  const names = new Set<string>();
  node.descendants((child) => {
    child.marks.forEach((mark) => names.add(mark.type.name));
  });
  return [...names].sort();
};

describe("details summary — formatting", () => {
  it.each([
    ["bold and italic", "Hello **bold** and *em*", ["bold", "italic"]],
    ["inline code", "Run `npm test` first", ["code"]],
    ["a link", "See [the docs](https://example.com/a)", ["link"]],
    ["a highlight", "An ==important== note", ["highlight"]],
    ["strikethrough", "Old ~~wrong~~ text", ["strike"]],
    ["nested marks", "A **bold *and italic* run**", ["bold", "italic"]],
    ["CJK with bold", "点击 **展开** 详情", ["bold"]],
  ])("keeps %s", (_label, summary, marks) => {
    const source = details(summary);
    const before = summaryOf(parseMarkdown(schema, source));
    expect(marksIn(before)).toEqual(marks);
    const once = roundTrip(source);
    expect(once).toBe(source);
    const after = summaryOf(parseMarkdown(schema, once));
    expect(marksIn(after)).toEqual(marks);
    expect(after.textContent).toBe(before.textContent);
  });
});

describe("details summary — text", () => {
  it.each([
    ["plain words", "Click to expand"],
    ["quotes", "The \"quoted\" and 'single' parts"],
    ["an ampersand", "Tom & Jerry"],
    ["a greater-than sign", "a > b"],
    ["CJK", "点击展开"],
  ])("writes %s back as it was", (_label, summary) => {
    const source = details(summary);
    expect(roundTrip(source)).toBe(source);
    expect(summaryOf(parseMarkdown(schema, source)).textContent).toBe(summary);
  });

  it.each([
    ["a less-than sign", "a &lt; b", "a < b"],
    ["a character reference", "Fish &amp; chips", "Fish & chips"],
    ["a literal character reference", "Write &amp;amp; for an ampersand", "Write &amp; for an ampersand"],
    ["an escaped asterisk pair", "2 \\* 3 \\* 4", "2 * 3 * 4"],
    ["an escaped underscore pair", "snake\\_case\\_name", "snake_case_name"],
    // `&` before a letter is escaped in summary text as in paragraph text.
    ["an ampersand before a letter", "AT&T", "AT&T"],
  ])("reads %s as text and does not escape it again on each save", (_label, summary, text) => {
    const source = details(summary);
    const before = summaryOf(parseMarkdown(schema, source));
    expect(before.textContent).toBe(text);
    expect(marksIn(before)).toEqual([]);
    const once = roundTrip(source);
    const twice = roundTrip(once);
    expect(twice).toBe(once);
    const after = summaryOf(parseMarkdown(schema, twice));
    expect(after.textContent).toBe(text);
    expect(marksIn(after)).toEqual([]);
  });

  it("keeps text that spells the closing tag from ending the summary", () => {
    const summary = schema.nodes.detailsSummary.create(null, [schema.text("a </summary> b")]);
    const block = schema.nodes.detailsBlock.create({ open: false }, [
      summary,
      schema.nodes.paragraph.create(null, [schema.text("body")]),
    ]);
    const doc = schema.topNodeType.create(null, [block]);
    const once = serializeMarkdown(schema, doc);
    const after = parseMarkdown(schema, once);
    expect(summaryOf(after).textContent).toBe("a </summary> b");
    expect(after.textContent).toBe("a </summary> bbody");
    expect(serializeMarkdown(schema, after)).toBe(once);
  });

  it("keeps a hard break inside the summary", () => {
    const summary = schema.nodes.detailsSummary.create(null, [
      schema.text("one"),
      schema.nodes.hardBreak.create(),
      schema.text("two"),
    ]);
    const block = schema.nodes.detailsBlock.create({ open: false }, [
      summary,
      schema.nodes.paragraph.create(null, [schema.text("body")]),
    ]);
    const once = serializeMarkdown(schema, schema.topNodeType.create(null, [block]));
    const after = summaryOf(parseMarkdown(schema, once));
    let breaks = 0;
    after.descendants((node) => {
      if (node.type.name === "hardBreak") breaks += 1;
    });
    expect(breaks).toBe(1);
    expect(after.textContent).toBe("onetwo");
    expect(roundTrip(once)).toBe(once);
  });

  it("writes an empty summary as an empty element", () => {
    const block = schema.nodes.detailsBlock.create({ open: false }, [
      schema.nodes.detailsSummary.create(),
      schema.nodes.paragraph.create(null, [schema.text("body")]),
    ]);
    expect(serializeMarkdown(schema, schema.topNodeType.create(null, [block]))).toBe(details(""));
  });

  it("drops a hard break that ends the summary", () => {
    const summary = schema.nodes.detailsSummary.create(null, [
      schema.text("Title"),
      schema.nodes.hardBreak.create(),
    ]);
    const block = schema.nodes.detailsBlock.create({ open: false }, [
      summary,
      schema.nodes.paragraph.create(null, [schema.text("body")]),
    ]);
    const once = serializeMarkdown(schema, schema.topNodeType.create(null, [block]));
    expect(once).toBe(details("Title"));
  });
});
