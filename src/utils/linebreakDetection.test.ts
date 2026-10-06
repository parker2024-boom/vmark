// @vitest-environment node
// WI-RA18.4 — the hard-break style is read from the breaks a parse finds, so
// math rows, table padding, code and a paragraph-final backslash do not count.
import { describe, it, expect } from "vitest";
import { detectLinebreaks } from "./linebreakDetection";
import { MAX_NESTING_DEPTH } from "./markdownPipeline/nestingDepth";

function normalizeResult(result: ReturnType<typeof detectLinebreaks>) {
  return { lineEnding: result.lineEnding, hardBreakStyle: result.hardBreakStyle };
}

describe("linebreakDetection", () => {
  it("detects LF line endings", () => {
    const input = "a\n\n b\n";
    expect(normalizeResult(detectLinebreaks(input)).lineEnding).toBe("lf");
  });

  it("detects CRLF line endings", () => {
    const input = "a\r\n\r\n b\r\n";
    expect(normalizeResult(detectLinebreaks(input)).lineEnding).toBe("crlf");
  });

  it("treats mixed line endings as CRLF when present", () => {
    const input = "a\nb\r\nc\r";
    expect(normalizeResult(detectLinebreaks(input)).lineEnding).toBe("crlf");
  });

  it("treats bare CR as CRLF", () => {
    const input = "a\rb\r";
    expect(normalizeResult(detectLinebreaks(input)).lineEnding).toBe("crlf");
  });

  it("returns unknown when no line endings exist", () => {
    const input = "single line";
    expect(normalizeResult(detectLinebreaks(input)).lineEnding).toBe("unknown");
  });

  it("returns unknown for empty text", () => {
    expect(normalizeResult(detectLinebreaks("")).lineEnding).toBe("unknown");
    expect(normalizeResult(detectLinebreaks("")).hardBreakStyle).toBe("unknown");
  });

  it("detects backslash hard breaks", () => {
    const input = "line\\\nnext";
    expect(normalizeResult(detectLinebreaks(input)).hardBreakStyle).toBe("backslash");
  });

  it("detects two-space hard breaks", () => {
    const input = "line  \nnext";
    expect(normalizeResult(detectLinebreaks(input)).hardBreakStyle).toBe("twoSpaces");
  });

  it("detects mixed hard break styles", () => {
    const input = "line  \nnext\\\nfinal";
    expect(normalizeResult(detectLinebreaks(input)).hardBreakStyle).toBe("mixed");
  });

  it("ignores fenced code blocks when detecting hard break style", () => {
    const input = [
      "```",
      "code line  ",
      "code line\\",
      "```",
      "text line\\",
      "next line",
    ].join("\n");

    expect(normalizeResult(detectLinebreaks(input)).hardBreakStyle).toBe("backslash");
  });

  it("counts a break after a fenced block, not the fence's own lines", () => {
    const input = ["```", "inside the fence  ", "```", "outside\\", "after"].join("\n");
    expect(normalizeResult(detectLinebreaks(input)).hardBreakStyle).toBe("backslash");
  });

  it("keeps a different fence character inside a fence as code", () => {
    // ~~~ does not close a ``` fence, so `code  ` is still code.
    const input = ["```", "~~~", "code  ", "```", "outside\\", "after"].join("\n");
    expect(normalizeResult(detectLinebreaks(input)).hardBreakStyle).toBe("backslash");
  });

  it.each([
    ["a row separator in $$ math", "$$\na \\\\\nb\n$$\n"],
    ["a single backslash in $$ math", "$$\na \\\nb\n$$\n"],
    ["table rows padded with spaces", "| a |  \n| - |  \n| b |  \n"],
    ["indented code with trailing spaces", "    code  \n    more\\\n"],
    ["an HTML block", "<div>\nline  \nline\\\n</div>\n"],
    ["a backslash ending a paragraph", "C:\\dir\\\n\nnext\n"],
    ["two spaces ending a paragraph", "end  \n\nnext\n"],
    ["a heading ending in a backslash", "# Title\\\ntext\n"],
    ["frontmatter", "---\ntitle: a  \n---\ntext\n"],
  ])("does not count %s as a hard break", (_label, input) => {
    expect(detectLinebreaks(input).hardBreakStyle).toBe("unknown");
  });

  it("reads the real breaks of a document that also holds look-alikes", () => {
    const input = [
      "| a |  ",
      "| - |",
      "",
      "$$",
      "x \\\\",
      "$$",
      "",
      "line one\\",
      "line two",
    ].join("\n");
    expect(detectLinebreaks(input).hardBreakStyle).toBe("backslash");
  });

  it("cannot tell the style of text nested too deeply to parse, and does not throw", () => {
    const input = `${"> ".repeat(MAX_NESTING_DEPTH + 1)}deep\\\nnext\n`;
    expect(detectLinebreaks(input).hardBreakStyle).toBe("unknown");
  });

  it.each([
    ["CRLF", "line  \r\nnext\r\n", "twoSpaces"],
    ["a byte-order mark", "\uFEFFline\\\nnext\n", "backslash"],
    ["CJK text", "中文\\\n日本語  \nend\n", "mixed"],
    ["a list item", "- item  \n  continued\n", "twoSpaces"],
    ["a blockquote", "> quoted\\\n> more\n", "backslash"],
  ])("reads breaks in %s", (_label, input, expected) => {
    expect(detectLinebreaks(input).hardBreakStyle).toBe(expected);
  });

  it("does not count whitespace-only lines with trailing spaces as two-space breaks", () => {
    // Line "    " has trailing spaces but before.trim() === "" → false branch of before.trim().length > 0
    const input = "    \nnext";
    expect(normalizeResult(detectLinebreaks(input)).hardBreakStyle).toBe("unknown");
  });
});
