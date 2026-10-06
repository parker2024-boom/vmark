// @vitest-environment node
// WI-RA2.1 — how many whole-document parses respelling costs. Each one is paid
// synchronously on the save path, so the count is part of the contract.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Processor } from "unified";

// Every markdown parse VMark runs goes through remark-parse's parser — the
// candidate search over the text as written, the document parses that verify
// the result, and any probe parse either of them needs. A pass-through wrapper
// on that third-party boundary counts them all, so the count is the real cost
// a save pays, not the number of calls into one VMark function.
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("remark-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-parse")>();
  function countedRemarkParse(this: Processor, ...args: Parameters<typeof actual.default>) {
    actual.default.apply(this, args);
    const parser = this.parser;
    if (parser === undefined) throw new Error("remark-parse installed no parser");
    this.parser = (document, file) => {
      parses.count += 1;
      return parser(document, file);
    };
  }
  return { ...actual, default: countedRemarkParse };
});

import { respellHardBreaks } from "./hardBreakRespell";

/**
 * Whole-document parses so far. A respelling that edits pays one parse of the
 * text as written to find candidate breaks, then two document parses (the
 * original and the edited text) to verify the edit changed nothing else.
 */
const total = (): number => parses.count;

beforeEach(() => {
  parses.count = 0;
});

describe("respellHardBreaks — parse count", () => {
  it.each([
    ["no line endings", "plain text", "twoSpaces"],
    ["only LaTeX row separators", "$$\na \\\\\nb \\\\\nc\n$$\n", "twoSpaces"],
    ["breaks already in the target spelling", "a  \nb\n", "twoSpaces"],
    ["breaks already in the target spelling", "a\\\nb\n", "backslash"],
  ] as const)("does not parse a document with %s", (_label, source, target) => {
    expect(respellHardBreaks(source, target)).toBe(source);
    expect(total()).toBe(0);
  });

  it.each([
    ["a table with trailing spaces", "| a |  \n| - |  \n", "backslash"],
    ["a backslash that ends a line of code", "```\na \\\nb\n```\n", "twoSpaces"],
  ] as const)("parses once when %s turns out to hold no break", (_label, source, target) => {
    expect(respellHardBreaks(source, target)).toBe(source);
    expect(total()).toBe(1);
  });

  it.each([
    ["twoSpaces", "a\\\nb\n", "a  \nb\n"],
    ["backslash", "a  \nb\n", "a\\\nb\n"],
  ] as const)("converts to %s with one finding parse and two verifying ones (three parses)", (target, source, expected) => {
    expect(respellHardBreaks(source, target)).toBe(expected);
    expect(total()).toBe(3);
  });

  // Each of these respellings would change the tree. Not attempting it leaves
  // nothing to verify — and, in a longer document, nothing to make the
  // verification of the other edits fail.
  it.each([
    ["a break that starts its line", "\\\nb\n", "twoSpaces"],
    ["a break after a soft break", "a\n\\\nb\n", "twoSpaces"],
    // No space after `>`: the character before the break is the marker, so
    // only the preceding text's own value says the line is otherwise empty.
    ["a break after a soft break in a tight blockquote", ">a\n>\\\n>b\n", "twoSpaces"],
    ["a break after a soft break in a blockquote", "> a\n> \\\n> b\n", "twoSpaces"],
    ["a backslash break after a space", "a \\\nb\n", "twoSpaces"],
    ["a backslash break after a tab", "a\t\\\nb\n", "twoSpaces"],
    ["a two-space break after an unpaired backslash", "a\\  \nb\n", "backslash"],
  ] as const)("does not attempt %s, so there is nothing to verify", (_label, source, target) => {
    expect(respellHardBreaks(source, target)).toBe(source);
    expect(total()).toBe(1);
  });

  // The same rules, seen from the output: the break that cannot be respelled
  // is skipped, and the one beside it is still converted.
  it.each([
    ["the second of two consecutive breaks", "a\\\n\\\nb\n", "twoSpaces", "a  \n\\\nb\n"],
    ["a break after a space", "a\\\nb \\\nc\n", "twoSpaces", "a  \nb \\\nc\n"],
    ["a break after an unpaired backslash", "a  \nb\\  \nc\n", "backslash", "a\\\nb\\  \nc\n"],
  ] as const)("skips %s and converts its neighbour", (_label, source, target, expected) => {
    expect(respellHardBreaks(source, target)).toBe(expected);
    expect(total()).toBe(3);
  });

  it("verifies once and gives up when an unforeseen edit changes the document", () => {
    // `| h |\` becomes a table header as `| h |  `. No rule foresees it; the
    // verification refuses, and the whole document is left as written.
    const source = "a\\\nb\n\n| h |\\\n| - |\n";
    expect(respellHardBreaks(source, "twoSpaces")).toBe(source);
    expect(total()).toBe(3);
  });
});
