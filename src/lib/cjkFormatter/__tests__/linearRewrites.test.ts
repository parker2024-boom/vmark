// @vitest-environment node
// WI-RA3.3 — each rule rewritten for linear cost returns exactly what the
// expression it replaced returned.
/**
 * `linearGrowth.test.ts` pins the cost. This file pins the behaviour: the
 * expressions that were replaced are kept here as oracles and compared with
 * the rules on generated strings drawn from the characters each rule reacts
 * to. A rewrite that is fast because it does less fails here.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  addCJKEnglishSpacing,
  collapseSpaces,
  convertNestedCornerQuotes,
  fixSlashSpacing,
  normalizeEllipsis,
} from "../rules";
import { CJK_LETTER_CLASS, LATIN_ALNUM, replaceDelimited } from "../rules/shared";
import { createRegionLookup } from "../protectedRegionSearch";
import { getTechnicalSubspanAt, isInLatinSpan, scanLatinSpans } from "../latinSpanScanner";
import { formatMarkdown } from "../formatter";
import { DEFAULT_CJK_FORMATTING } from "../types";

const strings = (alphabet: string[], maxLength = 30) =>
  fc.array(fc.constantFrom(...alphabet), { maxLength }).map((parts) => parts.join(""));

const RUNS = { numRuns: 4000 };

describe("fixSlashSpacing", () => {
  const legacy = (text: string): string =>
    text.replace(/(?<![/:])([ \t]*)\/([ \t]*)(?!\/)/g, (whole, left: string, right: string) =>
      left.length > 0 && right.length === 0 ? whole : "/",
    );

  it("matches the expression it replaces on generated input", () => {
    fc.assert(
      fc.property(strings(["/", "/", " ", " ", "\t", ":", "a", "中", "\n", "//", " / "]), (text) => {
        expect(fixSlashSpacing(text)).toBe(legacy(text));
      }),
      RUNS,
    );
  });

  it.each([
    ["both sides", "读 / 写", "读/写"],
    ["right side only", "读/ 写", "读/写"],
    ["left side only is a path", "路径 /usr/local", "路径 /usr/local"],
    ["a URL scheme", "http://a.b/c", "http://a.b/c"],
    ["blanks after a colon", "a:  / b", "a: /b"],
    ["two separators in a row", "a / / b", "a / /b"],
    ["two separators, wider gap", "a /   / b", "a//b"],
    ["a slash at the very start", "/ a", "/a"],
    ["a slash at the very end", "a /", "a /"],
    ["nothing to do", "中文", "中文"],
    ["empty", "", ""],
  ])("%s", (_label, input, expected) => {
    expect(fixSlashSpacing(input)).toBe(expected);
    expect(fixSlashSpacing(input)).toBe(legacy(input));
  });
});

describe("collapseSpaces", () => {
  const legacy = (text: string, hardBreaks: boolean, startsAtLineStart: boolean): string => {
    let out = hardBreaks
      ? text.replace(/(\S) {2,}(?![ ]*(?:\r?\n|$))/g, "$1 ")
      : text.replace(/(\S) {2,}/g, "$1 ");
    if (!startsAtLineStart) {
      out = hardBreaks ? out.replace(/^ {2,}(?![ ]*(?:\r?\n|$))/, " ") : out.replace(/^ {2,}/, " ");
    }
    return out;
  };

  it("matches the expressions it replaces on generated input", () => {
    fc.assert(
      fc.property(
        strings([" ", " ", "  ", "a", "中", "\n", "\r\n", "\t"]),
        fc.boolean(),
        fc.boolean(),
        (text, preserveTwoSpaceHardBreaks, startsAtLineStart) => {
          expect(collapseSpaces(text, { preserveTwoSpaceHardBreaks, startsAtLineStart })).toBe(
            legacy(text, preserveTwoSpaceHardBreaks, startsAtLineStart),
          );
        },
      ),
      RUNS,
    );
  });
});

describe("addCJKEnglishSpacing", () => {
  // The expression that matched the whole token, start to CJK character.
  const SIGN = "[-+−±－＋]";
  const CURRENCY = "[$¥€£₹]";
  const token =
    `(?:${SIGN}(?=\\d|${CURRENCY}[ ]?\\d))?(?:${CURRENCY}[ ]?)?(?:${SIGN}(?=\\d))?` +
    `${LATIN_ALNUM}+(?:[%‰℃℉]|°[CcFf]?|[ ]?(?:USD|CNY|EUR|GBP|RMB))?`;
  const legacy = (text: string): string =>
    text
      .replace(new RegExp(`([${CJK_LETTER_CLASS}])(${token})`, "gu"), "$1 $2")
      .replace(new RegExp(`(${token})([${CJK_LETTER_CLASS}])`, "gu"), "$1 $2");

  it("matches the expression it replaces on generated input", () => {
    const alphabet = [
      "中", "文", "a", "Z", "1", "é", "e\u{301}", "%", "‰", "℃", "°", "°C", "°F", " ", "-", "+", "$", "¥",
      "USD", "RMB", " USD", "\u{20bb7}", "한", "，", "\n",
    ];
    fc.assert(
      fc.property(strings(alphabet, 16), (text) => {
        expect(addCJKEnglishSpacing(text)).toBe(legacy(text));
      }),
      RUNS,
    );
  });
});

describe("normalizeEllipsis", () => {
  it("collapses spaced dots exactly as before the run-start anchor", () => {
    const legacySpaced = (text: string): string =>
      text.replace(/[ \t]*\.[ \t]+\.[ \t]+\.(?:[ \t]+\.)*/g, "...");
    const anchored = (text: string): string =>
      text.replace(/(?<![ \t])[ \t]*\.[ \t]+\.[ \t]+\.(?:[ \t]+\.)*/g, "...");
    fc.assert(
      fc.property(strings([".", ".", " ", " ", "\t", "a", "中", "\n", ". "]), (text) => {
        expect(anchored(text)).toBe(legacySpaced(text));
      }),
      RUNS,
    );
  });

  it("still normalizes the documented shapes", () => {
    expect(normalizeEllipsis("wait . . . ok")).toBe("wait... ok");
    expect(normalizeEllipsis("然后. . .继续")).toBe("然后……继续");
    expect(normalizeEllipsis("a  . . .")).toBe("a...");
  });
});

describe("convertNestedCornerQuotes", () => {
  // The expression it replaces, applied within each paragraph: a pair never
  // spans a paragraph break (WI-RA24.11, paragraphPairing.test.ts). Split here
  // independently of the helper under test.
  const legacyInParagraph = (text: string): string =>
    text.replace(/「([^」]*)」/g, (_, content: string) => {
      const converted = content.replace(/\u{2018}([^\u{2019}]*)\u{2019}/gu, "『$1』");
      return `「${converted}」`;
    });
  const legacy = (text: string): string =>
    text
      .split(/(\n[ \t>]*\r?\n)/)
      .map((part, i) => (i % 2 === 0 ? legacyInParagraph(part) : part))
      .join("");

  it("matches the expressions it replaces on generated input", () => {
    fc.assert(
      fc.property(strings(["「", "」", "\u{2018}", "\u{2019}", "中", "a", " ", "\n"]), (text) => {
        expect(convertNestedCornerQuotes(text)).toBe(legacy(text));
      }),
      RUNS,
    );
  });

  it("returns the same string object when nothing matched", () => {
    const text = "「没有结尾";
    expect(replaceDelimited(text, "「", "」", (c) => c)).toBe(text);
  });
});

describe("createRegionLookup", () => {
  const region = fc
    .tuple(fc.nat({ max: 40 }), fc.nat({ max: 12 }))
    .map(([start, length]) => ({ start, end: start + length }));

  it("answers like a walk over every region, in any order, overlapping or empty", () => {
    fc.assert(
      fc.property(fc.array(region, { maxLength: 12 }), (regions) => {
        const inside = createRegionLookup(regions);
        for (let pos = -1; pos <= 55; pos += 1) {
          expect(inside(pos)).toBe(regions.some((r) => pos >= r.start && pos < r.end));
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("is a snapshot: regions added afterwards are not seen", () => {
    const regions = [{ start: 0, end: 2 }];
    const inside = createRegionLookup(regions);
    regions.push({ start: 5, end: 9 });
    expect(inside(1)).toBe(true);
    expect(inside(6)).toBe(false);
    expect(createRegionLookup(regions)(6)).toBe(true);
  });

  it("is half-open", () => {
    const inside = createRegionLookup([{ start: 3, end: 6 }]);
    expect([2, 3, 5, 6].map(inside)).toEqual([false, true, true, false]);
  });
});

describe("Latin span lookups", () => {
  it("answer like a walk over every span and subspan", () => {
    const alphabet = ["中", "a", "1.5", "v1.2.3", "a@b.cc", "x.com", ",", " ", "\n", "12:30", "http://a.b"];
    fc.assert(
      fc.property(strings(alphabet, 14), (text) => {
        const spans = scanLatinSpans(text);
        for (let pos = -1; pos <= text.length; pos += 1) {
          const span = spans.find((s) => pos >= s.start && pos < s.end);
          expect(isInLatinSpan(pos, spans)).toBe(span !== undefined);
          const subspan =
            span?.subspans.find((s) => pos - span.start >= s.start && pos - span.start < s.end) ?? null;
          expect(getTechnicalSubspanAt(pos, spans)).toBe(subspan);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("the document's final newline", () => {
  it.each([
    ["LF", "中文\n", "中文\n"],
    ["CRLF", "中文\r\n", "中文\r\n"],
    ["several, mixed", "中文\r\n\n\n", "中文\r\n"],
    ["spaces before the newline", "中文  \n  \n", "中文\n"],
    ["none", "中文", "中文"],
    ["whitespace only", " \n\n", ""],
    ["blank lines inside the document", "中文\n\n\n\n中", "中文\n\n\n\n中"],
  ])("%s", (_label, input, expected) => {
    expect(formatMarkdown(input, DEFAULT_CJK_FORMATTING)).toBe(expected);
  });
});
