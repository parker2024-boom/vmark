// @vitest-environment node
// WI-RA2.3 — a document that opens with `---` and has no frontmatter keeps its
// lists and blockquotes. The frontmatter extension, once it has failed to find
// a closing fence, reads every later list and quote as a paragraph, so it is
// loaded only for a document that really has frontmatter.
import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import fc from "fast-check";
import { parseMarkdownToMdast } from "../parser";
import { analyzeContent } from "./remarkPlugins";

const types = (markdown: string): string[] =>
  parseMarkdownToMdast(markdown).children.map((child) => child.type);

/** Whether the frontmatter extension itself reads `markdown` as opening with frontmatter. */
const extensionReadsFrontmatter = (markdown: string): boolean =>
  unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).parse(markdown).children[0]?.type === "yaml";

describe("a document that opens with a thematic break", () => {
  it.each([
    ["a bullet list", "---\n\n- a\n- b\n", ["thematicBreak", "list"]],
    ["a list directly under it", "---\n- a\n", ["thematicBreak", "list"]],
    ["an ordered list", "---\n\n1. a\n", ["thematicBreak", "list"]],
    ["a blockquote", "---\n\n> q\n", ["thematicBreak", "blockquote"]],
    ["a list further down", "---\n\ntext\n\n- a\n", ["thematicBreak", "paragraph", "list"]],
    ["a longer rule", "----\n\n- a\n", ["thematicBreak", "list"]],
    ["a rule with trailing spaces", "---  \n\n- a\n", ["thematicBreak", "list"]],
  ])("reads %s after it", (_label, source, expected) => {
    expect(types(source)).toEqual(expected);
  });

  it.each([
    ["frontmatter", "---\ntitle: x\n---\n\n- a\n", ["yaml", "list"]],
    ["empty frontmatter", "---\n---\n\ntext\n", ["yaml", "paragraph"]],
    ["frontmatter with a blank line", "---\n\na: b\n\n---\n", ["yaml"]],
    ["frontmatter closed at the end of the document", "---\na: b\n---", ["yaml"]],
    ["frontmatter with CRLF line endings", "---\r\na: b\r\n---\r\n\r\ntext\r\n", ["yaml", "paragraph"]],
  ])("still reads %s", (_label, source, expected) => {
    expect(types(source)).toEqual(expected);
  });
});

describe("frontmatter detection agrees with the frontmatter extension", () => {
  it.each([
    "---\na: b\n---\n",
    "---\n---\n",
    "---\na: b\n---",
    "---  \na: b\n---  \n",
    "---\na: b\n--- x\n",
    "---\na: b\n----\n",
    "---\na: b\n ---\n",
    "----\na: b\n----\n",
    "---x\na: b\n---\n",
    " ---\na: b\n---\n",
    "\n---\na: b\n---\n",
    "---\n\n- a\n",
    "---",
    "---\n",
    "--\na\n--\n",
    "---\r\na: b\r\n---\r\n",
    "---\na\n\n---\n\n---\n",
    "",
    "text\n---\na\n---\n",
  ])("for %j", (source) => {
    expect(analyzeContent(source).hasFrontmatter).toBe(extensionReadsFrontmatter(source));
  });

  it("for generated documents", () => {
    const piece = fc.constantFrom("---", "----", "--", " ---", "--- ", "---x", "a: b", "- a", "", "text", "> q", "\t");
    const eol = fc.constantFrom("\n", "\n", "\r\n", "");
    const document = fc
      .array(fc.tuple(piece, eol), { minLength: 0, maxLength: 7 })
      .map((lines) => lines.map(([text, end]) => text + end).join(""));
    fc.assert(
      fc.property(document, (source) => {
        expect(analyzeContent(source).hasFrontmatter).toBe(extensionReadsFrontmatter(source));
      }),
      { numRuns: 1000, seed: 20261002 },
    );
  });
});
