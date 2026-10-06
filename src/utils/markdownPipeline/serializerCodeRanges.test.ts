// @vitest-environment node
// WI-RA26.5 — the cosmetic pass's code ranges cost linearly in the document,
// and a fence closes only on a run at least as long as its opener's.
//
// The fence pattern paired an opener with a lazy body and a closer. An opener
// with no closer was retried against the whole rest of the document, and a
// long run backtracked through every shorter length first, so a document of
// fence openers ("```a" lines, which cannot close one another) or of one long
// backtick run cost quadratic time: measured exponents 1.97 (backticks), 2.00
// (tildes) and 1.89 (a single run) from 4,000 to 16,000 characters. The ranges
// now come from the one-pass fence scanner the CJK formatter uses. Growth is
// measured on the thread's CPU clock, 4x apart, below 1.35 (the convention of
// the other growth tests).
import { describe, expect, it } from "vitest";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { buildCodeRanges, isInsideCodeRange } from "./serializerCodeRanges";

const MAX_EXPONENT = 1.35;
const repeatTo = (unit: string) => (n: number): string => unit.repeat(Math.ceil(n / unit.length));

const CASES = [
  { name: "backtick openers that never close", make: repeatTo("```a\n中文\n") },
  { name: "tilde openers that never close", make: repeatTo("~~~a\n中文\n") },
  { name: "one long backtick run", make: repeatTo("`") },
  { name: "closed fences", make: repeatTo("```js\ncode \\_x\n```\ntext \\_y\n") },
  { name: "inline code spans", make: repeatTo("a `b` c ") },
];

describe("buildCodeRanges scales linearly", () => {
  it.each(CASES)("$name", ({ name, make }) => {
    const small = make(4_000);
    const large = make(16_000);
    const cost = measureGrowth((text: string) => void buildCodeRanges(text), small, large);
    const exponent = growthExponent(cost, small.length, large.length);
    expect(
      exponent,
      `${name}: ${small.length} chars → ${cost.smallMs.toFixed(3)}ms, ${large.length} chars → ${cost.largeMs.toFixed(3)}ms ` +
        `(exponent ${exponent.toFixed(2)} on the ${cost.clock} clock; 1 is linear, 2 is quadratic)`,
    ).toBeLessThan(MAX_EXPONENT);
  });
});

describe("buildCodeRanges finds closed fences the way CommonMark closes them", () => {
  const inside = (text: string, needle: string) =>
    isInsideCodeRange(buildCodeRanges(text), text.indexOf(needle));

  it("covers a closed fence's body", () => {
    expect(inside("```js\nX\n```\nY\n", "X")).toBe(true);
    expect(inside("```js\nX\n```\nY\n", "Y")).toBe(false);
  });

  it.each(["`", "~"])("a shorter %s run does not close a longer fence", (c) => {
    const text = `${c.repeat(5)}\nX\n${c.repeat(3)}\nY\n${c.repeat(5)}\nZ\n`;
    expect(inside(text, "Y")).toBe(true);
    expect(inside(text, "Z")).toBe(false);
  });

  it("a longer run closes a fence", () => {
    expect(inside("```\nX\n`````\nY\n", "Y")).toBe(false);
  });

  it("the other fence character does not close a fence", () => {
    const text = "```\nX\n~~~\nY\n```\nZ\n";
    expect(inside(text, "Y")).toBe(true);
    expect(inside(text, "Z")).toBe(false);
  });

  it("a fence indented up to three spaces counts, as in a list item", () => {
    expect(inside("- item\n\n   ```\n   X\n   ```\n", "X")).toBe(true);
  });

  it("an opener that never closes is not a range: its text is still checked", () => {
    // Only a candidate filter: a fence the serializer wrote is always closed,
    // and an unclosed opener line here sits in raw HTML or math, not code.
    expect(inside("<div>\n```a\n</div>\n\\_x\n", "\\_x")).toBe(false);
  });

  it("reads CRLF line endings as LF ones", () => {
    const text = "```js\r\nX\r\n```\r\nY\r\n";
    expect(inside(text, "X")).toBe(true);
    expect(inside(text, "Y")).toBe(false);
  });

  it("keeps inline code spans and merges overlapping ranges", () => {
    expect(inside("a `X` b", "X")).toBe(true);
    expect(inside("a \\`X\\` b", "X")).toBe(false);
    expect(buildCodeRanges("```\n`a`\n```\n")).toEqual([[0, 11]]);
  });

  it("returns nothing for an empty document", () => {
    expect(buildCodeRanges("")).toEqual([]);
  });
});
