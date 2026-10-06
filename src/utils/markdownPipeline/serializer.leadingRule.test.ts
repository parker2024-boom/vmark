// @vitest-environment node
// WI-RA2.3 — a document that begins with a thematic break is written so that
// what follows the break reads back as what it was. `---` on the first line
// is also where frontmatter starts, and after it a list or a quote is read as
// a paragraph.
import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "./adapter";
import { getProductionSchema } from "@/test/productionSchema";

const schema = getProductionSchema();
const roundTrip = (markdown: string): string =>
  serializeMarkdown(schema, parseMarkdown(schema, markdown));

const blockTypes = (doc: PMNode): string[] => {
  const names: string[] = [];
  doc.forEach((child) => names.push(child.type.name));
  return names;
};

describe("a thematic break that opens the document", () => {
  it.each([
    ["a bullet list", "***\n\n- a\n- b\n", ["horizontalRule", "bulletList"]],
    ["an ordered list", "***\n\n1. a\n2. b\n", ["horizontalRule", "orderedList"]],
    ["a blockquote", "***\n\n> q\n", ["horizontalRule", "blockquote"]],
    ["a list and a later rule", "***\n\n- a\n\n***\n\ntext\n", ["horizontalRule", "bulletList", "horizontalRule", "paragraph"]],
  ])("keeps %s after it across two saves", (_label, source, expected) => {
    const before = parseMarkdown(schema, source);
    expect(blockTypes(before)).toEqual(expected);
    const once = roundTrip(source);
    expect(blockTypes(parseMarkdown(schema, once))).toEqual(expected);
    expect(roundTrip(once)).toBe(once);
  });

  it.each([
    ["alone", "---\n"],
    ["before a paragraph", "---\n\ntext\n"],
    ["before a heading", "---\n\n# Title\n"],
  ])("still writes `---` %s, where that is read back the same", (_label, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("writes `***` where `---` would open frontmatter", () => {
    const once = roundTrip("***\n\ntext\n\n---\n\nmore\n");
    expect(blockTypes(parseMarkdown(schema, once))).toEqual([
      "horizontalRule",
      "paragraph",
      "horizontalRule",
      "paragraph",
    ]);
  });
});
