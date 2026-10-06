// @vitest-environment node
// WI-RA3.3 — the formatter's cost grows linearly with the document, including
// on input built to make a pattern rescan.
/**
 * "Format CJK File" runs synchronously on the UI thread, so a super-linear
 * path is a frozen window. Every case here was measured at an exponent of 1.5
 * to 2.1 before the fix (an 8,000-character alphanumeric run cost one second),
 * and each has the same shape: a pattern that, on failing, is retried from the
 * next character and scans the same stretch again.
 *
 *   - a run of letters, digits or base64 that no CJK character ends;
 *   - a run of the characters an e-mail address or a domain may contain;
 *   - a long run of spaces or of line breaks;
 *   - an opener (`[`, `![`, `[[`, `[^`, `<a`, a backtick run) whose closer
 *     never comes;
 *   - thousands of protected regions or Latin spans, each looked up by
 *     walking the whole list.
 *
 * It asserts a GROWTH EXPONENT, never a duration (`@/test/cpuClock`): CPU time
 * of this thread, small and large runs interleaved, the minimum of each kept.
 * Instrumentation and a loaded machine change the constant, not the exponent.
 */
import { describe, it, expect } from "vitest";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { formatMarkdown } from "../formatter";
import { DEFAULT_CJK_FORMATTING, type CJKFormattingSettings } from "../types";

/** Linear is 1, quadratic is 2. */
const MAX_EXPONENT = 1.35;

const CORNER_QUOTES: CJKFormattingSettings = {
  ...DEFAULT_CJK_FORMATTING,
  quoteStyle: "corner",
  cjkCornerQuotes: true,
  cjkNestedQuotes: true,
};
const HARD_BREAKS = { preserveTwoSpaceHardBreaks: true };

const BASE64 =
  "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLw";
/** `unit` repeated and cut to exactly `n` characters. */
const fill = (unit: string, n: number): string =>
  unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

interface Case {
  name: string;
  make: (n: number) => string;
  config?: CJKFormattingSettings;
  options?: { preserveTwoSpaceHardBreaks: boolean };
}

const CASES: Case[] = [
  // Alphanumeric runs: the Latin-before-CJK spacing pattern and the e-mail pattern.
  { name: "a letter run after CJK", make: (n) => "中文 " + "a".repeat(n) },
  { name: "a letter run before CJK", make: (n) => "a".repeat(n) + " 中文" },
  { name: "a digit run", make: (n) => "中文 " + "7".repeat(n) },
  { name: "a base64 run", make: (n) => "中文 " + fill(BASE64, n) },
  { name: "an accented letter run", make: (n) => "中文 " + "é".repeat(n) },
  // Runs of e-mail and domain characters.
  { name: "a dotted letter run", make: (n) => "中文 " + fill("a.", n) },
  { name: "a dotted digit run", make: (n) => "中文 " + fill("1.", n) },
  { name: "a hyphenated run", make: (n) => "中文 " + fill("a-", n) },
  { name: "a percent-joined run", make: (n) => "中文 " + fill("a%", n) },
  { name: "labels that never end in a letter", make: (n) => "中文 x." + fill("a1.", n) + "1" },
  { name: "a run of hyphens", make: (n) => "中文" + "-".repeat(n) + "中文" },
  { name: "a run of dots", make: (n) => "中文" + ".".repeat(n) },
  { name: "many at-signs", make: (n) => "中文 " + fill("a@", n) },
  // Many spans and subspans, each looked up per punctuation mark.
  { name: "many decimals in one Latin span", make: (n) => "中文 " + fill("1.5 ", n) },
  { name: "many one-character Latin spans", make: (n) => fill("中,", n) },
  // Whitespace runs.
  { name: "a run of spaces", make: (n) => "中文" + " ".repeat(n) + "中" },
  { name: "a run of trailing spaces", make: (n) => "中文" + " ".repeat(n) + "\n中", options: HARD_BREAKS },
  { name: "a run of blank lines", make: (n) => "中文" + "\n".repeat(n) + "中" },
  { name: "blank lines then indented code", make: (n) => "中文\n" + "\n".repeat(n) + "    中" },
  // Openers whose closer never comes.
  { name: "open square brackets", make: (n) => "中文 " + "[".repeat(n) },
  { name: "image openers", make: (n) => "中文 " + fill("![", n) },
  { name: "link openers without a closing parenthesis", make: (n) => "中文 " + fill("[a](", n) },
  { name: "wiki-link openers", make: (n) => "中文 " + fill("[[a", n) },
  { name: "footnote openers", make: (n) => "中文 " + fill("[^a", n) },
  { name: "footnote-definition openers", make: (n) => "中文\n" + fill("[^a\n", n) },
  { name: "HTML tag openers", make: (n) => "中文 " + fill("<a ", n) },
  { name: "backtick runs of mixed length", make: (n) => "中文 " + fill("``a`", n) },
  { name: "backtick runs of growing length", make: (n) => "中文 " + growingBackticks(n) },
  { name: "an odd number of backticks", make: (n) => "中文 " + fill("a`", n) + "`" },
  { name: "an odd number of display-math delimiters", make: (n) => "中文 " + fill("$$a", n) },
  { name: "corner-quote openers", make: (n) => "中文" + "「".repeat(n), config: CORNER_QUOTES },
  { name: "single-quote openers in a corner quote", make: (n) => "「" + "‘".repeat(n) + "」中", config: CORNER_QUOTES },
  // Many protected regions, each checked against all the others.
  { name: "many inline code spans", make: (n) => fill("中`a` ", n) },
  { name: "many links", make: (n) => fill("中[a](b) ", n) },
  { name: "many HTML tags", make: (n) => fill("中<b>a</b> ", n) },
  // Controls: ordinary prose, which was already linear and must stay so.
  { name: "mixed prose", make: (n) => fill("中文abc123，混排test。", n) },
  { name: "prose lines", make: (n) => fill("第一行line one，结束。\n", n) },
];

/** Backtick runs of length 1, 2, 3, … separated by a letter: none can close another. */
function growingBackticks(n: number): string {
  let out = "";
  for (let k = 1; out.length < n; k += 1) out += "`".repeat(k) + "a";
  return out.slice(0, n);
}

describe("formatMarkdown scales linearly on hostile input", () => {
  it.each(CASES)("$name", (c) => {
    // 4× apart: linear costs ~4×, quadratic ~16×, and the bound sits at 6.5×.
    const small = c.make(4_000);
    const large = c.make(16_000);
    const config = c.config ?? DEFAULT_CJK_FORMATTING;
    const cost = measureGrowth((text: string) => void formatMarkdown(text, config, c.options), small, large);
    const exponent = growthExponent(cost, small.length, large.length);
    expect(
      exponent,
      `${c.name}: ${small.length} chars → ${cost.smallMs.toFixed(2)}ms, ${large.length} chars → ${cost.largeMs.toFixed(2)}ms ` +
        `(exponent ${exponent.toFixed(2)} on the ${cost.clock} clock; 1 is linear, 2 is quadratic)`,
    ).toBeLessThan(MAX_EXPONENT);
  });
});
