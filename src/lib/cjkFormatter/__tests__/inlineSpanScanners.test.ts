// @vitest-environment node
// WI-RA3.3 — the linear scanners accept exactly what the regular expressions
// they replace accepted.
/**
 * The expressions below are the ones the protected-region detector used. They
 * are correct and quadratic; the scanners are the same grammar read in one
 * pass. This file is the proof of "same grammar": every scanner is compared
 * with its expression on generated strings drawn from an alphabet made of the
 * delimiters themselves, where disagreement would show, plus the cases that
 * needed thought.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  forwardFinder,
  scanFootnoteDefinitions,
  scanFootnoteReferences,
  scanHtmlTags,
  scanImages,
  scanInlineCode,
  scanLinks,
  scanWikiLinks,
  type SpanMatch,
} from "../inlineSpanScanners";

/** Every match of a global expression, as ranges. */
function oracle(pattern: RegExp, text: string): SpanMatch[] {
  return [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

const LEGACY = {
  inlineCode: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g,
  image: /!\[[^\]]*\]\([^)]+\)/g,
  link: /\[([^\]]*)\]\(([^)]+)\)/g,
  htmlTag: /<[a-zA-Z][^>]*>|<\/[a-zA-Z][^>]*>/g,
  wikiLink: /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g,
  footnoteDefinition: /^\[\^[^\]]+\]:/gm,
  footnoteReference: /\[\^[^\]]+\]/g,
};

const ranges = (matches: SpanMatch[]): SpanMatch[] =>
  matches.map(({ start, end }) => ({ start, end }));

const SCANNERS: Array<[name: string, scan: (text: string) => SpanMatch[], pattern: RegExp, alphabet: string[]]> = [
  ["inline code", scanInlineCode, LEGACY.inlineCode, ["`", "`", "``", "```", "a", " ", "\n", "中"]],
  ["images", scanImages, LEGACY.image, ["!", "[", "]", "(", ")", "![", "](", "a", " ", "\n"]],
  ["links", (t) => ranges(scanLinks(t)), LEGACY.link, ["[", "]", "(", ")", "](", "!", "a", " ", "\n"]],
  ["HTML tags", scanHtmlTags, LEGACY.htmlTag, ["<", ">", "/", "</", "a", "1", " ", "\n", "中"]],
  ["wiki links", scanWikiLinks, LEGACY.wikiLink, ["[", "]", "[[", "]]", "|", "a", " ", "\n"]],
  [
    "footnote definitions",
    scanFootnoteDefinitions,
    LEGACY.footnoteDefinition,
    ["[^", "[", "^", "]", "]:", ":", "a", " ", "\n", "\r", "\u{2028}"],
  ],
  ["footnote references", scanFootnoteReferences, LEGACY.footnoteReference, ["[^", "[", "^", "]", ":", "a", " ", "\n"]],
];

describe("inline span scanners match the expressions they replace", () => {
  it.each(SCANNERS)("%s, on generated input", (_name, scan, pattern, alphabet) => {
    const input = fc
      .array(fc.constantFrom(...alphabet), { maxLength: 40 })
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(input, (text) => {
        expect(scan(text)).toEqual(oracle(pattern, text));
      }),
      { numRuns: 3000 },
    );
  });

  it.each(SCANNERS)("%s, on the empty string", (_name, scan) => {
    expect(scan("")).toEqual([]);
  });
});

describe("scanInlineCode", () => {
  it.each([
    ["a simple span", "a `b` c", [{ start: 2, end: 5 }]],
    ["a double-backtick span holding a backtick", "``a ` b``", [{ start: 0, end: 9 }]],
    ["an opener that gives up a backtick from its left", "```a``", [{ start: 1, end: 6 }]],
    ["a closer that must be the whole run", "`a`` b`", [{ start: 0, end: 7 }]],
    ["unclosed", "`a", []],
    ["adjacent runs with nothing between", "````", []],
    ["two spans", "`a` `b`", [{ start: 0, end: 3 }, { start: 4, end: 7 }]],
    ["a span across lines", "`a\nb`", [{ start: 0, end: 5 }]],
    ["an opener at the very end", "a `", []],
  ])("%s", (_label, text, expected) => {
    expect(scanInlineCode(text)).toEqual(expected);
    expect(scanInlineCode(text)).toEqual(oracle(LEGACY.inlineCode, text));
  });
});

describe("scanLinks", () => {
  it("reports the URL range the detector protects", () => {
    expect(scanLinks("见[链接](http://a.b)中")).toEqual([
      { start: 1, end: 17, urlStart: 6, urlEnd: 16 },
    ]);
  });

  it.each([
    ["an empty label", "[](u)", 1],
    ["an empty url", "[a]()", 0],
    ["a label holding an opening bracket", "[[a](u)", 1],
    ["no closing parenthesis", "[a](u", 0],
    ["brackets not followed by a parenthesis", "[a] (u)", 0],
    ["a url across lines", "[a](u\nv)", 1],
  ])("%s", (_label, text, count) => {
    expect(scanLinks(text)).toHaveLength(count);
    expect(ranges(scanLinks(text))).toEqual(oracle(LEGACY.link, text));
  });
});

describe("the other scanners, by example", () => {
  it("images need a non-empty url", () => {
    expect(scanImages("![a](b) ![c]()")).toEqual([{ start: 0, end: 7 }]);
  });

  it("HTML tags open with a letter, optionally after a slash", () => {
    expect(scanHtmlTags("<b>x</b> < b> <1> a<br/>")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 8 },
      { start: 19, end: 24 },
    ]);
  });

  it("wiki links need a target, and a display if there is a pipe", () => {
    expect(scanWikiLinks("[[a]] [[a|b]] [[|b]] [[a|]] [[]] [[a]")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 13 },
    ]);
  });

  it("a footnote definition is a reference at a line start followed by a colon", () => {
    const text = "[^1]: a\nsee [^1]: b\r[^n]:\n[^]:";
    expect(scanFootnoteDefinitions(text)).toEqual([
      { start: 0, end: 5 },
      { start: 20, end: 25 },
    ]);
    expect(scanFootnoteReferences(text)).toEqual([
      { start: 0, end: 4 },
      { start: 12, end: 16 },
      { start: 20, end: 24 },
    ]);
  });
});

describe("forwardFinder", () => {
  it("answers like indexOf for increasing positions", () => {
    const text = "a]b]c";
    const next = forwardFinder(text, "]");
    for (let from = 0; from <= text.length + 1; from += 1) {
      expect(next(from)).toBe(text.indexOf("]", from));
    }
  });

  it("answers like indexOf for positions asked out of order", () => {
    const text = "]a]b]";
    const next = forwardFinder(text, "]");
    for (const from of [4, 0, 3, 1, 5, 2, 0]) expect(next(from)).toBe(text.indexOf("]", from));
  });

  it("is consistent on generated questions", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "]"), { maxLength: 20 }).map((cs) => cs.join("")),
        fc.array(fc.nat({ max: 25 }), { maxLength: 30 }),
        (text, questions) => {
          const next = forwardFinder(text, "]");
          for (const from of questions) expect(next(from)).toBe(text.indexOf("]", from));
        },
      ),
    );
  });
});
