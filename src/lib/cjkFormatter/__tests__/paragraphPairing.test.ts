// @vitest-environment node
// WI-RA24.11 — a bracket or quote never pairs across a paragraph break. A blank
// line ends the paragraph, so an opener before it is unclosed: `(一\n\n二)` is
// two paragraphs with one stray paren each, not one parenthesized phrase. A
// single newline is a soft break inside one paragraph and still pairs.
import { describe, it, expect } from "vitest";
import { formatMarkdown } from "../formatter";
import { DEFAULT_CJK_FORMATTING, type CJKFormattingSettings } from "../types";
import { analyzeQuotes } from "../quotePairing";
import { computeQuoteToggle } from "../quoteToggle";

const format = (text: string, overrides: Partial<CJKFormattingSettings> = {}) =>
  formatMarkdown(text, { ...DEFAULT_CJK_FORMATTING, ...overrides });

/** The paragraph breaks a pairing must not cross: LF, CRLF, whitespace-only, blockquote. */
const BREAKS = ["\n\n", "\r\n\r\n", "\n \t\n", "\n>\n> "];

describe("brackets do not pair across a paragraph break", () => {
  it.each(BREAKS)("half-width parentheses around a break %j stay half-width", (br) => {
    const out = format(`(一${br}二)`);
    expect(out).not.toMatch(/[（）]/);
  });

  it.each(BREAKS)("square brackets around a break %j are not converted", (br) => {
    const out = format(`[一${br}二]`, { fullwidthBrackets: true });
    expect(out).not.toMatch(/[【】]/);
  });

  it("a soft line break inside one paragraph still pairs", () => {
    expect(format("(一\n二)")).toBe("（一\n二）");
    expect(format("[一\n二]", { fullwidthBrackets: true })).toBe("【一\n二】");
  });

  it("each paragraph still pairs its own brackets", () => {
    expect(format("(一)\n\n(二)")).toBe("（一）\n\n（二）");
  });
});

describe("quotes do not pair across a paragraph break", () => {
  it.each(BREAKS)("contextual quotes around a break %j stay unpaired", (br) => {
    const out = format(`"一${br}二"`);
    expect(out).not.toMatch(/[“”]/);
  });

  it("contextual quotes inside each paragraph still pair", () => {
    expect(format('"一"\n\n"二"')).toBe("“一”\n\n“二”");
  });

  it("a quote left open in one paragraph does not swallow the next paragraph's pair", () => {
    // The stray opener in the first paragraph used to pair with the next
    // paragraph's opener and leave its closer stranded.
    expect(format('"一\n\n"二"')).toBe('"一\n\n“二”');
  });

  it("corner conversion does not join quotes from two paragraphs", () => {
    const out = format("“一\n\n二”", { cjkCornerQuotes: true });
    expect(out).not.toMatch(/[「」]/);
  });

  it("nested corner conversion stays inside one paragraph", () => {
    const out = format("「甲‘乙\n\n丙’丁」", { cjkCornerQuotes: true, cjkNestedQuotes: true });
    expect(out).not.toMatch(/[『』]/);
  });

  it("the guillemet converter does not pair single quotes across a break", () => {
    expect(format("一'二\n\n三'四", { quoteStyle: "guillemets" })).not.toMatch(/[‹›]/);
  });

  it("the guillemet converter restarts its open/close parity in each paragraph", () => {
    // Parity carried over from the first paragraph's stray opener made the
    // second paragraph's first quote a closer.
    expect(format('甲"乙\n\n丙"丁"戊"', { quoteStyle: "guillemets" })).toBe("甲«乙\n\n丙«丁»戊»");
  });

  it("is stable under a second format", () => {
    for (const text of ["(一\n\n二)", '"一\n\n二"', '"一\n\n"二"', "一(二\n\n三)四"]) {
      const once = format(text);
      expect(format(once)).toBe(once);
    }
  });
});

describe("each paragraph formats as it would alone", () => {
  const PARAGRAPHS: Array<[string, string]> = [
    ["(一", "二)"],
    ["一(二", "三)四"],
    ['"一', '二"'],
    ['"一', '"二"'],
    ["一'二", "三'四"],
    ["[一", "二]"],
    ["“一", "二”"],
    ["「甲‘乙", "丙’丁」"],
    ['甲"乙', '丙"丁"戊"'],
  ];
  const OPTION_SETS: Array<Partial<CJKFormattingSettings>> = [
    {},
    { fullwidthBrackets: true },
    { cjkCornerQuotes: true, cjkNestedQuotes: true },
    { contextualQuotes: false },
    { quoteStyle: "guillemets" },
  ];

  it.each(OPTION_SETS)("with options %j", (options) => {
    for (const [first, second] of PARAGRAPHS) {
      expect(format(`${first}\n\n${second}`, options)).toBe(
        `${format(first, options)}\n\n${format(second, options)}`,
      );
    }
  });
});

describe("the pair analysis behind them", () => {
  it("never reports a pair spanning a blank line", () => {
    const { pairs, orphans } = analyzeQuotes('"一\n\n二"');
    expect(pairs).toEqual([]);
    expect(orphans.map((o) => o.index)).toEqual([0, 5]);
  });

  it("the quote toggle finds no enclosing pair across a paragraph break", () => {
    expect(computeQuoteToggle("“一\n\n二”", 3, "simple", "curly")).toBeNull();
    expect(computeQuoteToggle("「一\n\n二」", 3, "simple", "corner")).toBeNull();
    expect(computeQuoteToggle("「一\n二」", 2, "simple", "corner")).not.toBeNull();
  });
});
