// @vitest-environment node
// WI-RA3.3 — the e-mail and domain scanners accept exactly what the regular
// expressions they replace accepted, and the subspan finder is unchanged.
/**
 * The two expressions below rescanned a long run of letters, digits, dots or
 * hyphens from every position in it. The scanners read each run a constant
 * number of times; this file compares them with the expressions on generated
 * strings over the characters the two grammars are made of.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { SpanMatch } from "../inlineSpanScanners";
import { findTechnicalSubspans, scanDomains, scanEmails } from "../technicalSubspans";

function oracle(pattern: RegExp, text: string): SpanMatch[] {
  return [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

const LEGACY_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const LEGACY_DOMAIN = /\b[a-zA-Z][a-zA-Z0-9-]*\.[a-zA-Z0-9.-]+[a-zA-Z]\b/g;

const ALPHABET = ["a", "b", "Z", "1", ".", "-", "@", "_", "%", "+", " ", "é", "/", "ab", ".co", "a1."];
const input = fc
  .array(fc.constantFrom(...ALPHABET), { maxLength: 30 })
  .map((parts) => parts.join(""));

describe("scanEmails", () => {
  it("matches the expression it replaces on generated input", () => {
    fc.assert(
      fc.property(input, (text) => {
        expect(scanEmails(text)).toEqual(oracle(LEGACY_EMAIL, text));
      }),
      { numRuns: 5000 },
    );
  });

  it.each([
    ["a plain address", "user@example.com", [{ start: 0, end: 16 }]],
    ["a subdomain", "a@b.c.dd", [{ start: 0, end: 8 }]],
    ["a one-letter top level is not enough", "a@b.c", []],
    ["the host ends at the last dot two letters follow", "a@b.cc.d", [{ start: 0, end: 6 }]],
    ["a second address starting where the first ended", "a@b.cc.x@y.zz", [{ start: 0, end: 6 }, { start: 6, end: 13 }]],
    ["no local part", "@b.cc", []],
    ["no host label before the dot", "a@.cc", []],
    ["two at-signs", "a@b@c.dd", [{ start: 2, end: 8 }]],
    ["digits after the dot do not count as letters", "a@b.12", []],
    ["empty", "", []],
  ])("%s", (_label, text, expected) => {
    expect(scanEmails(text)).toEqual(expected);
    expect(scanEmails(text)).toEqual(oracle(LEGACY_EMAIL, text));
  });
});

describe("scanDomains", () => {
  it("matches the expression it replaces on generated input", () => {
    fc.assert(
      fc.property(input, (text) => {
        expect(scanDomains(text)).toEqual(oracle(LEGACY_DOMAIN, text));
      }),
      { numRuns: 5000 },
    );
  });

  it.each([
    ["a plain domain", "example.com", [{ start: 0, end: 11 }]],
    ["the tail needs two characters", "a.b", []],
    ["the shortest domain", "a.bc", [{ start: 0, end: 4 }]],
    ["starts at the first letter after a non-word", "1a-b.com", [{ start: 3, end: 8 }]],
    ["ends at the last letter before a non-word", "a.bc.1", [{ start: 0, end: 4 }]],
    ["an underscore is a word character on either side", "_a.bc a.bc_", []],
    ["a non-ASCII letter is not", "éa.bcé", [{ start: 1, end: 5 }]],
    ["one domain per run of host characters", "a.bc.de-fg.hi", [{ start: 0, end: 13 }]],
    ["two runs", "a.bc d.ef", [{ start: 0, end: 4 }, { start: 5, end: 9 }]],
    ["labels that never end in a letter", "x.a1.a1.a1", []],
    ["empty", "", []],
  ])("%s", (_label, text, expected) => {
    expect(scanDomains(text)).toEqual(expected);
    expect(scanDomains(text)).toEqual(oracle(LEGACY_DOMAIN, text));
  });
});

describe("findTechnicalSubspans", () => {
  it("gives a range to the most specific kind and refuses overlaps", () => {
    const text = "see https://example.com/a,b and user@example.com v1.2.3 at 12:30, 1,000 or 3.14 on example.org";
    expect(findTechnicalSubspans(text).map(({ type, text: t }) => [type, t])).toEqual([
      ["urlLike", "https://example.com/a,b"],
      ["emailLike", "user@example.com"],
      ["versionLike", "v1.2.3"],
      ["timeLike", "12:30"],
      ["thousandsLike", "1,000"],
      ["decimalLike", "3.14"],
      ["domainLike", "example.org"],
    ]);
  });

  it("returns subspans sorted by start, with positions that slice back to their text", () => {
    fc.assert(
      fc.property(input, (text) => {
        const subspans = findTechnicalSubspans(text);
        let previousEnd = 0;
        for (const subspan of subspans) {
          expect(subspan.start).toBeGreaterThanOrEqual(previousEnd);
          expect(text.slice(subspan.start, subspan.end)).toBe(subspan.text);
          previousEnd = subspan.end;
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("finds nothing in an empty span", () => {
    expect(findTechnicalSubspans("")).toEqual([]);
  });
});
