// @vitest-environment node
// WI-RA24.10 — finding fenced code costs linearly in the document, including
// when no fence opener ever finds its closer; and a fence closes only on a run
// at least as long as its opener's whole run.
//
// The pairing pattern retried every opener that has no closer against the
// whole rest of the document. A line like "```a" opens a fence but cannot
// close one, so a document of them cost k openers × the rest of the document:
// quadratic. A document of fences of DECREASING length hid the same cost
// behind a second defect: the pattern let an opener's run shrink by
// backtracking (six backticks read as a three-backtick fence with "```" as its
// info string), so a SHORTER run closed it, which CommonMark forbids — and the
// text after that false closer was formatted although the renderer shows it
// as code. Same conventions as linearGrowth.test.ts: a growth exponent on the
// thread's CPU clock, 4× apart, below 1.35.
import { describe, it, expect } from "vitest";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { formatMarkdown } from "../formatter";
import { findProtectedRegions } from "../markdownParser";
import { DEFAULT_CJK_FORMATTING } from "../types";

const MAX_EXPONENT = 1.35;

/** Fences of `char`, longest first, down to three, a CJK line after each, until `n` characters. */
function shrinkingFences(char: string, n: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let width = 3; size < n; width++) {
    lines.unshift(`${char.repeat(width)}\n中文line\n`);
    size += width + 8;
  }
  return lines.join("");
}

/** Closed fences, one after another — the ordinary case, which must stay linear. */
const closedFences = (n: number): string => "```js\n中文 code\n```\n中文段落\n".repeat(Math.ceil(n / 24));

/** Fence openers with an info string, which can never close one another. */
const openersOnly = (char: string) => (n: number): string => `${char.repeat(3)}a\n中文\n`.repeat(Math.ceil(n / 8));

const CASES = [
  { name: "backtick openers that never close", make: openersOnly("`") },
  { name: "tilde openers that never close", make: openersOnly("~") },
  { name: "backtick fences of decreasing length", make: (n: number) => shrinkingFences("`", n) },
  { name: "tilde fences of decreasing length", make: (n: number) => shrinkingFences("~", n) },
  { name: "closed fences", make: closedFences },
];

describe("fenced code detection scales linearly", () => {
  it.each(CASES)("$name", ({ name, make }) => {
    const small = make(4_000);
    const large = make(16_000);
    const cost = measureGrowth((text: string) => void formatMarkdown(text, DEFAULT_CJK_FORMATTING), small, large);
    const exponent = growthExponent(cost, small.length, large.length);
    expect(
      exponent,
      `${name}: ${small.length} chars → ${cost.smallMs.toFixed(2)}ms, ${large.length} chars → ${cost.largeMs.toFixed(2)}ms ` +
        `(exponent ${exponent.toFixed(2)} on the ${cost.clock} clock; 1 is linear, 2 is quadratic)`,
    ).toBeLessThan(MAX_EXPONENT);
  });

});

describe("a fence closes only on a run at least as long as its opener's", () => {
  const fenced = (text: string) => findProtectedRegions(text).filter((r) => r.type === "fenced_code");
  const format = (text: string) => formatMarkdown(text, DEFAULT_CJK_FORMATTING);

  it.each(["`", "~"])("a shorter %s run does not close a longer fence", (c) => {
    const text = `${c.repeat(5)}\n中文a\n${c.repeat(3)}\n中文text 后面\n`;
    // CommonMark leaves the five-run fence open to the end of the document.
    expect(fenced(text)).toEqual([{ start: 0, end: text.length, type: "fenced_code" }]);
    expect(format(text)).toBe(text);
  });

  it("an equal or longer run closes it, and text after it is formatted", () => {
    expect(format("````\n中文a\n`````\n中文text\n")).toBe("````\n中文a\n`````\n中文 text\n");
    expect(format("~~~~\n中文a\n~~~~  \n中文text\n")).toBe("~~~~\n中文a\n~~~~  \n中文 text\n");
  });

  it("a closer of the other character does not close it", () => {
    const text = "```\n中文a\n~~~\n中文text\n";
    expect(format(text)).toBe(text);
  });

  it("a fence's lines cannot reopen a fence after it closes", () => {
    const text = "```\n~~~\n```\n中文text\n";
    expect(fenced(text)).toEqual([{ start: 0, end: 11, type: "fenced_code" }]);
    expect(format(text)).toBe("```\n~~~\n```\n中文 text\n");
  });

  it("an unclosed fence claims the rest of the document, the decreasing ladder included", () => {
    const text = shrinkingFences("`", 200);
    expect(fenced(text)).toEqual([{ start: 0, end: text.length, type: "fenced_code" }]);
    expect(format(text)).toBe(text);
  });

  it("an opener on the last line, with no newline after it, still claims the rest", () => {
    const text = "中文text\n```js";
    expect(fenced(text)).toEqual([{ start: 7, end: text.length, type: "fenced_code" }]);
  });

  it("reads CRLF and lone-CR line endings as an LF document's", () => {
    expect(fenced("````\r\n中文\r\n```\r\n````\r\n中文text")).toEqual([{ start: 0, end: 19, type: "fenced_code" }]);
    expect(fenced("```\r中文\r```\r中文text")).toEqual([{ start: 0, end: 10, type: "fenced_code" }]);
  });

  it("four spaces of indentation is not a fence", () => {
    expect(fenced("    ```\n中文\n    ```\n")).toEqual([]);
  });
});
