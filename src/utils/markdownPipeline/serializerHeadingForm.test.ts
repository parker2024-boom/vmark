// @vitest-environment node
// WI-RA18.3 — a heading whose only line endings are inside inline code or math
// is written ATX on every save; any other line ending keeps it setext.
import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { flattenHeadingSpanLineEndings } from "./serializerHeadingForm";

const heading = (depth: 1 | 2 | 3, children: unknown[]): Root =>
  ({ type: "root", children: [{ type: "heading", depth, children }] }) as Root;

const firstHeadingChildren = (tree: Root): unknown =>
  (tree.children[0] as { children: unknown }).children;

describe("flattenHeadingSpanLineEndings", () => {
  it.each([
    ["inline math", { type: "inlineMath", value: "a \\\\\n| b" }, { type: "inlineMath", value: "a \\\\ | b" }],
    ["inline code", { type: "inlineCode", value: "a\r\nb" }, { type: "inlineCode", value: "a b" }],
    ["CJK math", { type: "inlineMath", value: "甲\n乙" }, { type: "inlineMath", value: "甲 乙" }],
  ])("writes the line endings of %s as spaces when nothing else needs a second line", (_label, span, flat) => {
    const tree = heading(2, [{ type: "text", value: "x " }, span]);
    expect(firstHeadingChildren(flattenHeadingSpanLineEndings(tree))).toEqual([{ type: "text", value: "x " }, flat]);
  });

  it.each([
    ["a text line ending", { type: "text", value: "a\nb" }],
    ["a hard break", { type: "break" }],
    ["inline HTML with a line ending", { type: "html", value: "<b\n>" }],
  ])("leaves a heading that holds %s alone, spans and all", (_label, other) => {
    const tree = heading(1, [other, { type: "inlineMath", value: "a\nb" }]);
    expect(flattenHeadingSpanLineEndings(tree)).toBe(tree);
  });

  it("leaves a heading too deep for setext alone", () => {
    const tree = heading(3, [{ type: "inlineMath", value: "a\nb" }]);
    expect(flattenHeadingSpanLineEndings(tree)).toBe(tree);
  });

  it("returns the same tree when no heading needs it, and never changes the tree handed in", () => {
    const plain = heading(2, [{ type: "inlineCode", value: "one line" }]);
    expect(flattenHeadingSpanLineEndings(plain)).toBe(plain);

    const tree = heading(2, [{ type: "inlineMath", value: "a\nb" }]);
    const snapshot = JSON.stringify(tree);
    flattenHeadingSpanLineEndings(tree);
    expect(JSON.stringify(tree)).toBe(snapshot);
  });

  it("reaches headings nested in other blocks", () => {
    const tree = {
      type: "root",
      children: [{ type: "blockquote", children: [{ type: "heading", depth: 1, children: [{ type: "inlineCode", value: "a\nb" }] }] }],
    } as Root;
    const out = flattenHeadingSpanLineEndings(tree);
    expect(JSON.stringify(out)).toContain('"value":"a b"');
  });
});
