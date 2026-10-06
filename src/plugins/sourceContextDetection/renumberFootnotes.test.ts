// WI-RA17A.1 — byte-exact output of renumberFootnotes, one row per decision it makes
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renumberFootnotes } from "./footnoteActions";

describe("renumberFootnotes exact output", () => {
  it.each([
    {
      name: "relabels out-of-order numeric labels",
      doc: "A[^2] B[^1]\n\n[^2]: Two\n[^1]: One",
      out: "A[^1] B[^2]\n\n[^1]: Two\n[^2]: One",
    },
    {
      name: "moves a definition at document start to the end",
      doc: "[^1]: Early def\n\nText [^1] here\n\nMore text",
      out: "\nText [^1] here\n\nMore text\n\n[^1]: Early def",
    },
    {
      name: "drops an orphaned definition when labels are already sequential",
      doc: "Text [^1]\n\n[^1]: Used\n[^2]: Orphan",
      out: "Text [^1]\n\n[^1]: Used",
    },
    {
      name: "adds an empty placeholder for a reference with no definition",
      doc: "Text [^1] and [^2]\n\n[^1]: Has def",
      out: "Text [^1] and [^2]\n\n[^1]: Has def\n[^2]: ",
    },
    {
      name: "moves a definition followed by body text",
      doc: "Text [^1]\n\n[^1]: Def\n\nTrailing paragraph",
      out: "Text [^1]\n\n\nTrailing paragraph\n\n[^1]: Def",
    },
    {
      name: "drops a reference that sits inside a removed definition",
      doc: "[^1]: Some text [^2] here\n\n[^2]: Def two",
      out: "\n\n[^1]: Def two",
    },
    {
      name: "keeps a label first seen inside a definition body",
      doc: "A [^b]\n\n[^a]: x\n\n[^b]: y [^a]",
      out: "A [^1]\n\n[^1]: y [^a]\n[^2]: x",
    },
    {
      name: "relabels around CJK text and leaves non-ASCII labels alone",
      doc: "脚注[^注]测试[^2]\n\n[^2]: 第二",
      out: "脚注[^注]测试[^1]\n\n[^1]: 第二",
    },
    {
      name: "orders CJK definitions by first reference",
      doc: "中文[^b]与[^a]\n\n[^a]: 甲\n[^b]: 乙",
      out: "中文[^1]与[^2]\n\n[^1]: 乙\n[^2]: 甲",
    },
    {
      name: "drops the carriage return of a CRLF definition line",
      doc: "Line [^2]\r\n\r\n[^2]: crlf def\r\n",
      out: "Line [^1]\n\n[^1]: crlf def",
    },
    {
      name: "leaves fenced-code definitions in place and adds a placeholder",
      doc: "```\n[^9]: in code\n```\nText [^9]",
      out: "```\n[^9]: in code\n```\nText [^1]\n\n[^1]: ",
    },
    {
      name: "moves a definition with no blank line around it",
      doc: "Text [^1]\n[^1]: tight def\nafter",
      out: "Text [^1]\n\nafter\n\n[^1]: tight def",
    },
    {
      name: "relabels a repeated alphanumeric reference",
      doc: "[^x]: only def, ref later\nBody [^x] and [^x] again",
      out: "\nBody [^1] and [^1] again\n\n[^1]: only def, ref later",
    },
  ])("$name", ({ doc, out }) => {
    expect(renumberFootnotes(doc)).toBe(out);
  });

  // Two definitions separated only by blank lines are removed as one block.
  // The position shift applied to later references must match that block, or
  // a relabelled reference lands one character off and corrupts the text.
  it.each([
    {
      name: "relabels a reference after two blank-line-separated definitions",
      doc: "Intro [^z] mid [^y] end [^z]\n\n[^y]: Why\n\n\n[^z]: Zed\n    more zed\n\nOutro [^y]\n\n",
      out: "Intro [^1] mid [^2] end [^1]\n\n\nOutro [^2]\n\n[^1]: Zed\n    more zed\n[^2]: Why",
    },
    {
      name: "relabels a long label after three adjacent definitions",
      doc: "A [^c]\n\n[^a]: 1\n\n[^b]: 2\n\n[^c]: 3\n\nB [^long-label] C [^a]",
      out: "A [^1]\n\n\nB [^2] C [^3]\n\n[^1]: 3\n[^2]: \n[^3]: 1",
    },
  ])("$name", ({ doc, out }) => {
    expect(renumberFootnotes(doc)).toBe(out);
  });

  it("returns null when definitions already trail the text, even with trailing whitespace", () => {
    expect(renumberFootnotes("Text [^1]   \n\n[^1]: Def   \n\n")).toBeNull();
  });
});
