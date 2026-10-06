// @vitest-environment node
// WI-RA2.1 — generated documents: hard-break normalization never changes a
// byte of math, HTML, a table or code, never changes what the document means,
// and the hard-break style never changes what a serialized document means.
/**
 * Property tests for hard-break normalization and hard-break style.
 *
 * Two generators, because they find different things.
 *
 * STRUCTURED documents are built from blocks of a known kind. Every block —
 * prose AND the constructs that must be left alone — gets line endings that
 * look like hard breaks (a backslash, two, three, two or three spaces, tabs),
 * so protected constructs constantly hold break look-alikes and prose
 * constantly holds real breaks in both spellings. Knowing each block's kind is
 * what lets a test say "this block's bytes may not change".
 *
 * MESSY documents are lines assembled from markers, words and line endings
 * with no structure promised. They reach what the structured ones cannot:
 * text that is only text because of what follows it (`1.`, `-`), emphasis
 * running across a break, stray tags, lines the document parse rewrites
 * before reading. Each defect this file was written against first appeared in
 * documents like these while the structured properties were green.
 *
 * A normalizer that returned its input unchanged would satisfy "nothing
 * protected changed" and "the meaning is unchanged" trivially. Two things rule
 * that out: the generator must produce convertible breaks, and in prose every
 * break left unconverted must be one that could not be.
 *
 * @coordinates-with @/utils/linebreaks — normalizeHardBreaks, the save-time pass
 * @coordinates-with ../hardBreakRespell.ts — its rules and its verification
 * @coordinates-with ../hardBreakRanges.ts — the candidate breaks
 * @coordinates-with ../serializerBreak.ts — the spelling on the serialize side
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Node as PMNode } from "@tiptap/pm/model";
import { normalizeHardBreaks } from "@/utils/linebreaks";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown, serializeMarkdown } from "../adapter";
import { parseMarkdownToMdast } from "../parser";
import { findHardBreakRanges, type HardBreakRange } from "../hardBreakRanges";

const schema = getProductionSchema();
const STYLES = ["twoSpaces", "backslash"] as const;
type Style = (typeof STYLES)[number];

/** Fixed so a failure reproduces; fast-check prints the counterexample. */
const SEED = 20261002;
// These properties pass no timeout of their own: they run under the suite's
// liveness bound (`LIVENESS_TIMEOUT_MS`, vitest.shared.ts), set from what is
// unambiguously a hang. A per-test bound below it is a performance assertion
// in disguise: CPU-bound properties overran 30 s and 120 s on a loaded box
// while correct, and a real regression fails on an assertion, not by running
// long.

// ---- structured generator ---------------------------------------------------

const WORDS = ["alpha", "beta", "gamma", "delta", "中文", "日本語", "x1", "é", "😀"];
const word = fc.constantFrom(...WORDS);
const phrase = fc.array(word, { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));

/** What a line may end with: every break look-alike, and nothing. */
const lineTail = fc.constantFrom("", "", "\\", "\\\\", "\\\\\\", "  ", "   ", "\t\t", " \\", "\\  ");
const line = fc.tuple(phrase, lineTail).map(([text, tail]) => text + tail);
const lines = (min: number, max: number) => fc.array(line, { minLength: min, maxLength: max });

interface Block {
  text: string;
  /** True when no byte of `text` may change. */
  protectedBlock: boolean;
  /** Set on the two kinds whose adjacency changes what the second one is. */
  kind?: "list" | "indentedCode";
}

const prose = lines(1, 4).map((ls): Block => ({ text: ls.join("\n"), protectedBlock: false }));
const blockquote = lines(1, 3).map(
  (ls): Block => ({ text: ls.map((l) => `> ${l}`).join("\n"), protectedBlock: false }),
);
const list = lines(1, 3).map(
  (ls): Block => ({
    text: ls.map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`)).join("\n"),
    protectedBlock: false,
    kind: "list",
  }),
);
const mathBlock = lines(1, 3).map(
  (ls): Block => ({ text: ["$$", ...ls, "$$"].join("\n"), protectedBlock: true }),
);
const delimiterMath = lines(1, 3).map(
  (ls): Block => ({ text: ["\\[", ...ls, "\\]"].join("\n"), protectedBlock: true }),
);
const htmlBlock = lines(1, 3).map(
  (ls): Block => ({ text: ["<div>", ...ls, "</div>"].join("\n"), protectedBlock: true }),
);
const fencedCode = fc.tuple(fc.constantFrom("```", "~~~"), lines(1, 3)).map(
  ([fence, ls]): Block => ({ text: [fence, ...ls, fence].join("\n"), protectedBlock: true }),
);
const indentedCode = lines(1, 3).map(
  (ls): Block => ({
    text: ls.map((l) => `    ${l}`).join("\n"),
    protectedBlock: true,
    kind: "indentedCode",
  }),
);
/**
 * A table, by construction: only whitespace may follow a row's closing pipe,
 * so every row keeps one cell. Cell CONTENT still takes every tail, so a row
 * can hold `\` or trailing spaces before its closing pipe.
 */
const rowTail = fc.constantFrom("", "", "  ", "   ", "\t\t");
const table = fc.tuple(rowTail, rowTail, fc.array(fc.tuple(line, rowTail), { minLength: 1, maxLength: 2 })).map(
  ([headTail, ruleTail, rows]): Block => ({
    text: [`| h |${headTail}`, `| - |${ruleTail}`, ...rows.map(([cell, tail]) => `| ${cell} |${tail}`)].join("\n"),
    protectedBlock: true,
  }),
);

/**
 * Lines that look like a table and are not one: any tail may follow the
 * closing pipe, and a backslash there is a second cell the delimiter row does
 * not have. The block is then a paragraph whose line endings are real hard
 * breaks — and respelling one can make the header valid and the paragraph a
 * table. Not protected: the claim for it is that its MEANING does not change.
 */
const pipeLines = fc.tuple(lineTail, lineTail, lines(0, 2)).map(
  ([headTail, ruleTail, rows]): Block => ({
    text: [`| h |${headTail}`, `| - |${ruleTail}`, ...rows.map((r) => `| ${r} |`)].join("\n"),
    protectedBlock: false,
  }),
);

const proseBlock = fc.oneof({ weight: 4, arbitrary: prose }, blockquote, list);
const block = fc.oneof(
  { weight: 4, arbitrary: prose },
  { weight: 2, arbitrary: blockquote },
  { weight: 2, arbitrary: list },
  { weight: 2, arbitrary: pipeLines },
  mathBlock,
  delimiterMath,
  htmlBlock,
  fencedCode,
  indentedCode,
  table,
);

/**
 * Blocks joined by one blank line.
 *
 * Four-space-indented lines are code only where nothing claims them first. A
 * list item does: after `- item` and a blank line they are a paragraph INSIDE
 * the item, whose line endings are real hard breaks. So an indented-code block
 * is never generated directly after a list — it would be labelled protected
 * while being prose. (Hard breaks inside a list item are generated by `list`.)
 */
const documentBlocks = fc
  .array(block, { minLength: 1, maxLength: 7 })
  .filter((blocks) =>
    blocks.every((b, index) => !(b.kind === "indentedCode" && blocks[index - 1]?.kind === "list")),
  );
const proseBlocks = fc.array(proseBlock, { minLength: 1, maxLength: 6 });
const render = (blocks: Block[]): string => `${blocks.map((b) => b.text).join("\n\n")}\n`;

// ---- messy generator --------------------------------------------------------

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
  .map(([ls, finalNewline]) => ls.join("\n") + (finalNewline ? "\n" : ""));

// ---- helpers ----------------------------------------------------------------

/** The document parse, positions removed: what the editor reads the text as. */
const meaning = (markdown: string): string =>
  JSON.stringify(parseMarkdownToMdast(markdown), (key, value: unknown) =>
    key === "position" ? undefined : value,
  );

const roundTrip = (markdown: string, style: Style): string =>
  serializeMarkdown(schema, parseMarkdown(schema, markdown), { hardBreakStyle: style });

/** A document's content with the attributes that only record source layout removed. */
const contentOf = (doc: PMNode): string =>
  JSON.stringify(doc.toJSON(), (key, value: unknown) =>
    key === "sourceLine" || key === "blankLinesBefore" ? undefined : value,
  );

const breaksOf = (markdown: string): HardBreakRange[] => {
  const found = findHardBreakRanges(markdown);
  if (found === null) throw new Error("generated document unexpectedly refused as too deep");
  return found;
};

/** `markdown` with each of `breaks` (in source order) written in the other spelling. */
function respellAll(markdown: string, breaks: readonly HardBreakRange[]): string {
  let output = "";
  let cursor = 0;
  for (const found of breaks) {
    output += markdown.slice(cursor, found.start) + (found.spelling === "backslash" ? "  " : "\\");
    cursor = found.end - 1;
  }
  return output + markdown.slice(cursor);
}

/** Whether writing `breaks` in the other spelling changes what `markdown` means. */
const changesMeaning = (markdown: string, breaks: readonly HardBreakRange[]): boolean =>
  meaning(respellAll(markdown, breaks)) !== meaning(markdown);

// ---- properties: structured documents ---------------------------------------

describe("hard-break normalization — structured documents", () => {
  it("the generator produces convertible breaks and protected look-alikes", () => {
    const samples = fc.sample(documentBlocks, { numRuns: 300, seed: SEED });
    let withBackslashBreak = 0;
    let withSpaceBreak = 0;
    let withProtectedLookAlike = 0;
    for (const blocks of samples) {
      const found = breaksOf(render(blocks));
      if (found.some((b) => b.spelling === "backslash" && !b.startsLine)) withBackslashBreak += 1;
      if (found.some((b) => b.spelling === "twoSpaces")) withSpaceBreak += 1;
      if (blocks.some((b) => b.protectedBlock && /(\\| {2})\n/.test(`${b.text}\n`))) {
        withProtectedLookAlike += 1;
      }
    }
    // Floors far below what the generator yields; they fail only if it stops
    // exercising the thing the other properties claim to test.
    expect(withBackslashBreak).toBeGreaterThan(60);
    expect(withSpaceBreak).toBeGreaterThan(60);
    expect(withProtectedLookAlike).toBeGreaterThan(60);
  });

  it("never changes a byte of a protected construct, or the number of blocks", () => {
    fc.assert(
      fc.property(documentBlocks, fc.constantFrom(...STYLES), (blocks, style) => {
        const output = normalizeHardBreaks(render(blocks), style);
        const outputBlocks = output.replace(/\n$/, "").split("\n\n");
        expect(outputBlocks).toHaveLength(blocks.length);
        blocks.forEach((b, index) => {
          if (b.protectedBlock) expect(outputBlocks[index]).toBe(b.text);
        });
      }),
      { numRuns: 400, seed: SEED },
    );
  });

  it("never changes what the document means", () => {
    fc.assert(
      fc.property(documentBlocks, fc.constantFrom(...STYLES), (blocks, style) => {
        const source = render(blocks);
        expect(meaning(normalizeHardBreaks(source, style))).toBe(meaning(source));
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  // Judged by the document's meaning, not by a copy of the normalizer's rules.
  it("in prose, leaves a break unconverted only when respelling it would change the document", () => {
    fc.assert(
      fc.property(proseBlocks, fc.constantFrom(...STYLES), (blocks, style) => {
        const output = normalizeHardBreaks(render(blocks), style);
        const couldHaveConverted = breaksOf(output)
          .filter((found) => found.spelling !== style)
          .filter((found) => !changesMeaning(output, [found]));
        expect(couldHaveConverted).toEqual([]);
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  // Verification is all or nothing (hardBreakRespell.ts): one respelling the
  // rules do not foresee leaves the whole document as written. So with any
  // block kind the claim is weaker — if breaks are left, something among them
  // could not be respelled.
  it("in any document, leaves breaks unconverted only when some respelling would change it", () => {
    fc.assert(
      fc.property(documentBlocks, fc.constantFrom(...STYLES), (blocks, style) => {
        const output = normalizeHardBreaks(render(blocks), style);
        const left = breaksOf(output).filter((found) => found.spelling !== style);
        if (left.length === 0) return;
        const explained =
          left.some((found) => changesMeaning(output, [found])) || changesMeaning(output, left);
        expect(explained).toBe(true);
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(documentBlocks, fc.constantFrom(...STYLES), (blocks, style) => {
        const once = normalizeHardBreaks(render(blocks), style);
        expect(normalizeHardBreaks(once, style)).toBe(once);
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("serialize∘parse is stable after one round, in either style", () => {
    fc.assert(
      fc.property(documentBlocks, fc.constantFrom(...STYLES), (blocks, style) => {
        const once = roundTrip(render(blocks), style);
        expect(roundTrip(once, style)).toBe(once);
      }),
      { numRuns: 200, seed: SEED },
    );
  });
});

// ---- properties: messy documents --------------------------------------------

describe("hard-break normalization — messy documents", () => {
  it("never changes what the document means, is idempotent, and does not throw", () => {
    fc.assert(
      fc.property(messyDocument, fc.constantFrom(...STYLES), (source, style) => {
        const once = normalizeHardBreaks(source, style);
        expect(meaning(once)).toBe(meaning(source.replace(/\r\n?/g, "\n")));
        expect(normalizeHardBreaks(once, style)).toBe(once);
      }),
      { numRuns: 400, seed: SEED },
    );
  });
});

describe("hard-break style — messy documents", () => {
  // The spelling of a hard break is a spelling. Whatever a document is, saving
  // it in one style or the other must give text that reads back the same —
  // the same breaks, the same text around them, the same blocks.
  it("reads back the same document whichever style it was written in", () => {
    fc.assert(
      fc.property(messyDocument, (source) => {
        const doc = parseMarkdown(schema, source);
        const [asSpaces, asBackslash] = STYLES.map((style) =>
          parseMarkdown(schema, serializeMarkdown(schema, doc, { hardBreakStyle: style })),
        );
        expect(contentOf(asSpaces)).toBe(contentOf(asBackslash));
      }),
      { numRuns: 600, seed: SEED },
    );
  });
});
