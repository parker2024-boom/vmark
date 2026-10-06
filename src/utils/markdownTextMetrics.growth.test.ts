// @vitest-environment node
// WI-RA26.5 — stripping markdown for the word count costs linearly in the
// document, and strips exactly what it stripped before.
//
// The fence pattern (```` ```[\s\S]*?``` ````) is NOT quadratic: every ```
// pairs with the next one, so no opener scans past the next marker (measured
// 0.92–1.07 on openers that never close, decreasing ladders, long runs). Four
// other patterns of the same function were, by the same mechanism — a
// pattern retried at each start scans an unbounded run when it has no closer:
// the image and link patterns on "[" or "](" with no "]" or ")" after it
// (1.77–1.86), and the two list-marker patterns, whose `^[\s]*` is retried at
// every line start of a whitespace-only run (2.01 blank lines, 2.10 space
// lines, 2.25 tab lines). The status bar runs this on every edit.
//
// The output must not change: `components/StatusBar/incrementalTextMetrics.ts`
// mirrors this function's semantics and is held to it by its equivalence
// test. So the replacement scanners are checked against the original regex
// chain (REFERENCE below) on fixed edge cases and on generated documents.
import { describe, expect, it } from "vitest";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { stripMarkdown } from "./markdownTextMetrics";

const MAX_EXPONENT = 1.35;
const repeatTo = (unit: string) => (n: number): string => unit.repeat(Math.ceil(n / unit.length));

const CASES = [
  { name: "fence openers that never close", make: repeatTo("```a\n中文\n") },
  { name: "one long backtick run", make: repeatTo("`") },
  { name: "link openers with no closing bracket", make: repeatTo("[a ") },
  { name: "image openers with no closing bracket", make: repeatTo("![a ") },
  { name: "link destinations with no closing paren", make: repeatTo("[a](") },
  { name: "image destinations with no closing paren", make: repeatTo("![a](") },
  { name: "blank lines", make: repeatTo("\n") },
  { name: "space-only lines", make: repeatTo(" \n") },
  { name: "tab-only lines", make: repeatTo("\t\n") },
  { name: "ordinary prose with links and lists", make: repeatTo("- see [docs](https://x.y/a_(b)) **now**\n1. 中文 ![i](p.png)\n\n") },
];

describe("stripMarkdown scales linearly", () => {
  it.each(CASES)("$name", ({ name, make }) => {
    const small = make(4_000);
    const large = make(16_000);
    const cost = measureGrowth((text: string) => void stripMarkdown(text), small, large);
    const exponent = growthExponent(cost, small.length, large.length);
    expect(
      exponent,
      `${name}: ${small.length} chars → ${cost.smallMs.toFixed(3)}ms, ${large.length} chars → ${cost.largeMs.toFixed(3)}ms ` +
        `(exponent ${exponent.toFixed(2)} on the ${cost.clock} clock; 1 is linear, 2 is quadratic)`,
    ).toBeLessThan(MAX_EXPONENT);
  });
});

/** The regex chain stripMarkdown used before the linear scanners: the oracle. */
function REFERENCE(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

describe("stripMarkdown strips exactly what the regex chain stripped", () => {
  it.each([
    "",
    "plain",
    "![alt](img.png) and [label](url)",
    "![](u) [x]() [](y) [[a]](b) [a [b](c)",
    "[a](b(c)) [a](b(c) [a]\n(b) [a\n\nb](c)",
    "![a]( [b](c ![d](",
    "[a] [b](c [d] (e)",
    "- a\n* b\n+ c\n-\n- \n\t- d\n   1. e\n10. f\n1.g\n2.\n3. ",
    "\n\n\n- a\n\n\n\n1. b\n \n \n* c",
    "-\n- a\n\n-\n\n1.\n2. b",
    "\r\n- a\r\n\r\n1. b\r- c - d + e - f　- g",
    "> - quote item\n# - heading item\n---\n- after rule",
    "中文 [链接](地址) ![图](路径)\n- 列表\n1. 编号",
    "*a* _b_ **c** __d__ `e` ```f```\n```\ng\n```",
  ])("%j", (text) => {
    expect(stripMarkdown(text)).toBe(REFERENCE(text));
  });

  it("on generated documents", () => {
    // A seeded generator over the characters the patterns care about, so a
    // failure is reproducible from the seed in the message.
    const alphabet = ["[", "]", "(", ")", "!", "-", "*", "+", "_", "#", ">", "`", ".", "1", "2", "a", "中", " ", "\t", "\n", "\r", " "];
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let doc = 0; doc < 3000; doc++) {
      const length = next() % 60;
      let text = "";
      for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length];
      expect(stripMarkdown(text), `document ${doc}: ${JSON.stringify(text)}`).toBe(REFERENCE(text));
    }
  });
});
