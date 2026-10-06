// @vitest-environment node
// WI-RA2.1 — save-time hard-break normalization rewrites only what the parser
// reads as a hard break: math, HTML blocks, tables and code keep their bytes.
// WI-RA2.2 — a literal trailing backslash is never made into, or out of, a
// hard break, and a table row never gains one.
import { describe, it, expect } from "vitest";
import { normalizeHardBreaks, HARD_BREAK_NORMALIZE_LIMIT } from "./linebreaks";

const STYLES = ["twoSpaces", "backslash"] as const;

describe("normalizeHardBreaks — constructs that are not hard breaks", () => {
  it.each([
    ["a LaTeX row separator in a $$ block", "$$\na \\\\\nb\n$$\n"],
    ["an odd backslash run in a $$ block", "$$\na \\\nb  \nc\n$$\n"],
    ["inline math spanning lines", "x $a \\\nb  \nc$ y\n"],
    ["an HTML block", "<div>\na \\\nb  \nc\n</div>\n"],
    ["a table with trailing spaces", "| a |  \n| - |  \n| b |  \n"],
    ["a table cell ending in backslashes", "| a\\\\ |\n| - |\n| b\\ |\n"],
    ["indented code", "para\n\n    code  \n    more \\\n    end\n"],
    ["fenced code", "```\na  \nb \\\nc\n```\n"],
    ["tilde-fenced code", "~~~\na  \nb \\\nc\n~~~\n"],
    ["frontmatter", "---\na: b  \nc: d \\\n---\n\nx\n"],
    ["an ATX heading", "# a  \n\n## b\\\n"],
    ["a link title spanning lines", '[a](u "t  \nt\\\nt")\n'],
    ["a compact <details> block", "<details>\n<summary>S</summary>\na\\\nb  \nc\n</details>\n"],
    ["display math in \\[ \\] delimiters", "\\[\na  \nb \\\nc\n\\]\n"],
    ["trailing tabs", "a\t\t\nb\n"],
    ["a whitespace-only line", "a\n\n    \nb\n"],
  ])("leaves %s byte-identical in both styles", (_label, source) => {
    for (const style of STYLES) {
      expect(normalizeHardBreaks(source, style)).toBe(source);
    }
  });
});

describe("normalizeHardBreaks — literal backslashes and paragraph ends", () => {
  it("keeps a paragraph-final backslash, which is literal text", () => {
    const source = "foo\\\n\nbar\n";
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  it("keeps a backslash at the end of the document", () => {
    expect(normalizeHardBreaks("foo\\", "twoSpaces")).toBe("foo\\");
    expect(normalizeHardBreaks("foo\\\n", "twoSpaces")).toBe("foo\\\n");
  });

  it("does not add a backslash to paragraph-final trailing spaces", () => {
    expect(normalizeHardBreaks("foo  \n\nbar\n", "backslash")).toBe("foo  \n\nbar\n");
    expect(normalizeHardBreaks("foo  ", "backslash")).toBe("foo  ");
  });

  it("does not turn an escaped backslash before a soft break into a hard break", () => {
    const source = "C:\\dir\\\\\nnext\n";
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  it("converts a real break that follows an escaped backslash", () => {
    // `\\` is one literal backslash; the third backslash is the break.
    expect(normalizeHardBreaks("a\\\\\\\nb\n", "twoSpaces")).toBe("a\\\\  \nb\n");
  });

  it("leaves a two-space break alone when a backslash would pair with a literal one", () => {
    // `a\` + two spaces: literal backslash, then a break. Writing the break as
    // a backslash gives `a\\`, an escaped backslash and no break at all.
    const source = "a\\  \nb\n";
    expect(normalizeHardBreaks(source, "backslash")).toBe(source);
  });

  it("converts a two-space break after an escaped backslash", () => {
    expect(normalizeHardBreaks("a\\\\  \nb\n", "backslash")).toBe("a\\\\\\\nb\n");
  });
});

describe("normalizeHardBreaks — real hard breaks", () => {
  it.each([
    ["a paragraph", "a\\\nb\n", "a  \nb\n"],
    ["a blockquote", "> a\\\n> b\n", "> a  \n> b\n"],
    ["a list item", "- a\\\n  b\n", "- a  \n  b\n"],
    ["a footnote definition", "[^1]: a\\\n    b\n", "[^1]: a  \n    b\n"],
    ["a multi-line <details> body", "<details>\n<summary>S</summary>\n\na\\\nb\n\n</details>\n", "<details>\n<summary>S</summary>\n\na  \nb\n\n</details>\n"],
    ["emphasis", "*a\\\nb*\n", "*a  \nb*\n"],
    ["CJK text", "中文\\\n日本語\n", "中文  \n日本語\n"],
    ["astral characters", "😀\\\n😀\n", "😀  \n😀\n"],
  ])("converts a break in %s both ways", (_label, backslash, twoSpaces) => {
    expect(normalizeHardBreaks(backslash, "twoSpaces")).toBe(twoSpaces);
    expect(normalizeHardBreaks(twoSpaces, "backslash")).toBe(backslash);
    expect(normalizeHardBreaks(backslash, "backslash")).toBe(backslash);
    expect(normalizeHardBreaks(twoSpaces, "twoSpaces")).toBe(twoSpaces);
  });

  it("collapses a longer run of trailing spaces to one backslash", () => {
    expect(normalizeHardBreaks("a     \nb\n", "backslash")).toBe("a\\\nb\n");
  });

  it("converts breaks beside protected constructs without touching them", () => {
    const source = "a\\\nb\n\n$$\nx \\\\\ny\n$$\n\n| t |  \n| - |\n\nc\\\nd\n";
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(
      "a  \nb\n\n$$\nx \\\\\ny\n$$\n\n| t |  \n| - |\n\nc  \nd\n",
    );
  });

  it("keeps a break that starts its line a backslash, since spaces would make a blank line", () => {
    expect(normalizeHardBreaks("\\\nb\n", "twoSpaces")).toBe("\\\nb\n");
    expect(normalizeHardBreaks("a\\\n\\\nb\n", "twoSpaces")).toBe("a  \n\\\nb\n");
    // After a soft break inside a container: the prefix is not content.
    expect(normalizeHardBreaks("> a\n> \\\n> b\n", "twoSpaces")).toBe("> a\n> \\\n> b\n");
  });

  it.each([
    ["a space", "a \\\nb\n"],
    ["a tab", "a\t\\\nb\n"],
    ["several spaces", "a   \\\nb\n"],
  ])("keeps a backslash break after %s, whose text two spaces would swallow", (_label, source) => {
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  // `| h |\` has two cells — `h`, and the backslash after the last pipe —
  // against a one-cell delimiter row, so the block is a paragraph whose first
  // line ends in a hard break. Respelled, `| h |  ` has one cell and the block
  // is a table. No rule about the characters around the break sees that; only
  // comparing the document before and after does.
  it("keeps a break whose respelling would turn its paragraph into a table", () => {
    const source = "| h |\\\n| - |\n| alpha |\n";
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  it("keeps the same break when the header's second cell has a space before it", () => {
    const source = "| h | \\\n| - |\n| alpha |\n";
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  it("leaves the whole document as written when one respelling would change it", () => {
    // The first and last paragraphs hold ordinary breaks. Verification is all
    // or nothing, so they stay too.
    const source = "a\\\nb\n\n| h |\\\n| - |\n\nc\\\nd\n";
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  it("keeps two breaks that only together would make a table", () => {
    // Either backslash alone can become spaces and the block stays a
    // paragraph; with both, `| h |` over `| - |` is a table.
    const source = "| h |\\\n| - |\\\n| alpha |\n";
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  // The document parse rewrites its source before reading it, so it can read
  // a line differently from a parse of the text as written. In each case here
  // the trailing spaces look like a hard break to the latter and are not one
  // to the former; a backslash in their place would be a literal backslash
  // added to the text.
  it.each([
    ["a bare list marker on the next line", "| - || #   \n    -   \n"],
    ["a bare list marker line", "x\n    -  \ny\n"],
    ["an unclosed $$ fence below", "> a  \n\\[#\\\\\\\n$$#   \n<div>b </b>   \n  \\\\\n\\[   \n\\]\t\n\n```c\n"],
  ])("does not add a backslash before %s", (_label, source) => {
    expect(normalizeHardBreaks(source, "backslash")).toBe(source);
  });

  it("converts a pipe line's break when it stays a paragraph either way", () => {
    // Two cells before and after: never a table against a one-cell rule.
    expect(normalizeHardBreaks("| h |x\\\n| - |\n", "twoSpaces")).toBe("| h |x  \n| - |\n");
  });

  // `\[ … \]` on its own lines is display math to the editor, and a math
  // block ends the paragraph above it. So the line above is the paragraph's
  // LAST line: its backslash is literal and its trailing spaces are nothing.
  // It must be left alone — and must not stop the rest of the document from
  // being converted.
  it.each([
    ["a backslash", "first\\\nsecond\n\nabove\\\n\\[\nx\n\\]\n", "twoSpaces", "first  \nsecond\n\nabove\\\n\\[\nx\n\\]\n"],
    ["two spaces", "first  \nsecond\n\nabove  \n\\[\nx\n\\]\n", "backslash", "first\\\nsecond\n\nabove  \n\\[\nx\n\\]\n"],
    ["a backslash, math indented", "first\\\nsecond\n\nabove\\\n  \\[\nx\n  \\]\n", "twoSpaces", "first  \nsecond\n\nabove\\\n  \\[\nx\n  \\]\n"],
  ] as const)("converts around a line ending in %s directly above display math", (_label, source, target, expected) => {
    expect(normalizeHardBreaks(source, target)).toBe(expected);
  });

  it("still converts a break above inline math, which does not end the paragraph", () => {
    expect(normalizeHardBreaks("above\\\n\\(x\\) tail\n", "twoSpaces")).toBe("above  \n\\(x\\) tail\n");
  });

  it("returns LF text for CRLF and lone-CR input", () => {
    expect(normalizeHardBreaks("a\\\r\nb\r\n", "twoSpaces")).toBe("a  \nb\n");
    expect(normalizeHardBreaks("a  \rb\r", "backslash")).toBe("a\\\nb\n");
    expect(normalizeHardBreaks("$$\r\na \\\\\r\nb\r\n$$\r\n", "twoSpaces")).toBe("$$\na \\\\\nb\n$$\n");
  });

  it.each(STYLES)("is idempotent in %s style", (style) => {
    const source = "a\\\nb  \nc\n\n> d  \n> e\\\n> f\n\n$$\nx \\\\\ny\n$$\n";
    const once = normalizeHardBreaks(source, style);
    expect(normalizeHardBreaks(once, style)).toBe(once);
  });
});

describe("normalizeHardBreaks — inputs it does not parse", () => {
  it.each(STYLES)("returns empty input unchanged in %s style", (style) => {
    expect(normalizeHardBreaks("", style)).toBe("");
  });

  it("leaves a document too deeply nested to parse as written", () => {
    const source = `${"> ".repeat(1200)}a\\\n${"> ".repeat(1200)}b\n`;
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  it("leaves a document over the size limit as written", () => {
    const line = "a\\\nb\n\n";
    const source = line.repeat(Math.ceil((HARD_BREAK_NORMALIZE_LIMIT + 1) / line.length));
    expect(source.length).toBeGreaterThan(HARD_BREAK_NORMALIZE_LIMIT);
    expect(normalizeHardBreaks(source, "twoSpaces")).toBe(source);
  });

  it("still normalizes a document at the size limit", () => {
    const head = "a\\\nb\n\n";
    const source = head + "x".repeat(HARD_BREAK_NORMALIZE_LIMIT - head.length);
    expect(source.length).toBe(HARD_BREAK_NORMALIZE_LIMIT);
    expect(normalizeHardBreaks(source, "twoSpaces").startsWith("a  \nb\n")).toBe(true);
  });
});
