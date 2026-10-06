// @vitest-environment node
/**
 * Property-based round-trip tests for the markdown pipeline.
 *
 * Purpose: the fixed characterization corpus (22 hand-written fixtures) found
 * D1–D4 by hand. These properties GENERATE thousands of documents and assert
 * the invariants those defects violated, so the *next* round-trip corruption is
 * caught automatically instead of by inspection.
 *
 * Two kinds of property:
 *   1. Stability (idempotence): serialize∘parse is a fixed point — a second
 *      round-trip must not change the first's output. Robust to normalization
 *      (the first pass normalizes; the second must be stable), so any failure is
 *      a real oscillation/corruption bug.
 *   2. Data preservation (D1–D4 families): generated media alt text, link
 *      titles, highlights, and escaped markers must survive a round-trip.
 *
 * @coordinates-with ../adapter.ts — parseMarkdown / serializeMarkdown
 * @coordinates-with @/test/productionSchema — the production WYSIWYG schema
 * @coordinates-with ./characterization/ — the fixed-fixture counterpart
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseMarkdown, serializeMarkdown } from "../adapter";
import { getProductionSchema } from "@/test/productionSchema";

const schema = getProductionSchema();
const roundtrip = (md: string): string =>
  serializeMarkdown(schema, parseMarkdown(schema, md));

// ---- safe building blocks (letters + spaces only, so a stability failure is a
// real bug, not a generator artifact around escaping/whitespace) -------------
const WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "alpha", "beta", "gamma",
  "delta", "text", "content", "sample", "note", "value", "item",
];
const word = fc.constantFrom(...WORDS);
const phrase = fc
  .array(word, { minLength: 1, maxLength: 5 })
  .map((w) => w.join(" "));
const url = fc.constantFrom(
  "https://example.com/a",
  "https://example.com/b",
  "https://example.org/x/y",
);
const mediaFile = fc.constantFrom("clip.mp4", "song.mp3", "photo.png", "art.svg");

// ---- inline construct generators (each joined by a space so they never touch)
const inline = fc.oneof(
  phrase,
  phrase.map((t) => `**${t}**`),
  phrase.map((t) => `*${t}*`),
  phrase.map((t) => `\`${t}\``),
  fc.tuple(phrase, url).map(([t, u]) => `[${t}](${u})`),
  fc.tuple(phrase, url, phrase).map(([t, u, ti]) => `[${t}](${u} "${ti}")`),
  phrase.map((t) => `==${t}==`),
  fc.tuple(phrase, word).map(([t, b]) => `==${t} **${b}**==`),
);

// ---- block generators -------------------------------------------------------
const paragraph = fc
  .array(inline, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join(" "));
const heading = fc
  .tuple(fc.integer({ min: 1, max: 6 }), phrase)
  .map(([lvl, t]) => `${"#".repeat(lvl)} ${t}`);
const bulletList = fc
  .array(phrase, { minLength: 1, maxLength: 4 })
  .map((items) => items.map((i) => `- ${i}`).join("\n"));
const block = fc.oneof(paragraph, heading, bulletList);

const document = fc
  .array(block, { minLength: 1, maxLength: 6 })
  .map((blocks) => blocks.join("\n\n"));

// These properties pass no timeout of their own: they run under the suite's
// liveness bound (`LIVENESS_TIMEOUT_MS`, vitest.shared.ts), set from what is
// unambiguously a hang. A per-test bound below it is a performance assertion
// in disguise: CPU-bound properties overran 30 s and 120 s on a loaded box
// while correct, and a real regression fails on an assertion, not by running
// long.

describe("markdown pipeline — round-trip properties", () => {
  it("is idempotent: a second round-trip does not change the first's output", () => {
    fc.assert(
      fc.property(document, (md) => {
        const once = roundtrip(md);
        const twice = roundtrip(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  // ---- D1: block media alt text survives (was dropped: ![](clip.mp4)) -------
  it("D1: preserves media alt text through the round-trip", () => {
    fc.assert(
      fc.property(phrase, mediaFile, (alt, file) => {
        const out = roundtrip(`![${alt}](${file})`);
        expect(out).toContain(alt);
        expect(out).toContain(`(${file})`);
      }),
      { numRuns: 200 },
    );
  });

  // ---- D2: link title survives (was dropped: [t](url)) ---------------------
  it("D2: preserves link titles through the round-trip", () => {
    fc.assert(
      fc.property(phrase, url, phrase, (text, u, title) => {
        const out = roundtrip(`[${text}](${u} "${title}")`);
        expect(out).toContain(`"${title}"`);
      }),
      { numRuns: 200 },
    );
  });

  // ---- D3: highlight (incl. nested mark) is not corrupted / escaped --------
  it("D3: preserves highlight marks (including nested bold) without escaping", () => {
    fc.assert(
      fc.property(phrase, fc.option(word, { nil: undefined }), (t, bold) => {
        const src = bold ? `==${t} **${bold}**==` : `==${t}==`;
        const out = roundtrip(src);
        expect(out).toContain("==");
        // the highlight delimiters must not come back escaped
        expect(out).not.toContain("\\==");
      }),
      { numRuns: 200 },
    );
  });

  // ---- D4: escaped superscript markers stay escaped (were lost) ------------
  it("D4: keeps escaped ^ markers escaped through the round-trip", () => {
    fc.assert(
      fc.property(phrase, fc.integer({ min: 1, max: 99 }), (t, n) => {
        const out = roundtrip(`${t} x\\^${n}\\^ end`);
        expect(out).toContain("\\^");
        // must not have collapsed into real superscript syntax
        expect(out).not.toContain(`x^${n}^`);
      }),
      { numRuns: 200 },
    );
  });
});

// ---- messy documents (WI-RA18.3) ---------------------------------------------
// Lines assembled from block markers, inline markers, words and hard-break
// look-alikes, with no structure promised — the generator of
// hardBreakNormalization.property.test.ts. The letters-only generator above
// cannot reach what these found: a `$$` that starts a line (only its first `$`
// was escaped, so the second opened math that swallowed a hard break), a
// heading whose only line ending was inside inline math (setext on one save,
// ATX on the next), and a paragraph after a nested list (written tight, so it
// became the nested item's lazy continuation).
const MESSY_PREFIX = [
  "", "", "", "> ", "- ", "  ", "    ", "1. ", ">", "| ", "# ", "$$", "```", "<div>", "</div>",
  "\\[", "\\]", "---", "| - |",
];
const MESSY_WORDS = [
  "a", "bb", "中", "x*y", "`c`", "[l](u)", "<b>", "</b>", "$m$", "é", "😀", "#", "1.", "-", ">", "|", "==",
  "*i", "j*", "**s", "t**",
];
const MESSY_TAILS = ["", "", "\\", "\\\\", "\\\\\\", "  ", "   ", "\t", " \\", "\\  ", "\\ ", " "];
const messyLine = fc.oneof(
  { weight: 1, arbitrary: fc.constant("") },
  {
    weight: 5,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...MESSY_PREFIX),
        fc.array(fc.constantFrom(...MESSY_WORDS), { maxLength: 3 }),
        fc.constantFrom(...MESSY_TAILS),
      )
      .map(([prefix, words, tail]) => prefix + words.join(" ") + tail),
  },
);
const messyDocument = fc
  .tuple(fc.array(messyLine, { minLength: 1, maxLength: 9 }), fc.boolean())
  .map(([lines, finalNewline]) => lines.join("\n") + (finalNewline ? "\n" : ""));

const STYLES = ["twoSpaces", "backslash"] as const;
const roundtripIn = (md: string, style: (typeof STYLES)[number]): string =>
  serializeMarkdown(schema, parseMarkdown(schema, md), { hardBreakStyle: style });
const hardBreaks = (md: string): number => {
  let count = 0;
  parseMarkdown(schema, md).descendants((node) => {
    if (node.type.name === "hardBreak") count += 1;
  });
  return count;
};
/** Seeds that each found one of the defects above; fixed so a failure reproduces. */
const MESSY_SEEDS = [4, 13, 15, 24];

// Like the properties above, these run under the suite's liveness bound. A
// messy-document property costs ~5 s alone on a loaded box — measured.

describe("markdown pipeline — round-trip properties, messy documents", () => {
  it.each(MESSY_SEEDS)("is stable after one round, in either style (seed %i)", (seed) => {
    fc.assert(
      fc.property(messyDocument, fc.constantFrom(...STYLES), (md, style) => {
        const once = roundtripIn(md, style);
        expect(roundtripIn(once, style)).toBe(once);
      }),
      { numRuns: 300, seed },
    );
  });

  it.each(MESSY_SEEDS)("keeps every hard break, in either style (seed %i)", (seed) => {
    fc.assert(
      fc.property(messyDocument, fc.constantFrom(...STYLES), (md, style) => {
        expect(hardBreaks(roundtripIn(md, style))).toBe(hardBreaks(md));
      }),
      { numRuns: 300, seed },
    );
  });
});
