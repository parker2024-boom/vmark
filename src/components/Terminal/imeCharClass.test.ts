// @vitest-environment node
/**
 * Character classes for the terminal IME layer.
 *
 * The ASCII / non-ASCII split decides whether the gate treats an insert as
 * IME-origin text or as something xterm's keydown path already handled.
 */
import { describe, it, expect } from "vitest";
import { ALL_ASCII_RE, NON_ASCII_RE } from "./imeCharClass";

describe("ASCII detectors", () => {
  it.each(["你", "。", "？", "a你"])("NON_ASCII_RE matches %s", (s) => {
    expect(NON_ASCII_RE.test(s)).toBe(true);
  });

  it.each(["a", "/", "abc", "1"])("NON_ASCII_RE does not match %s", (s) => {
    expect(NON_ASCII_RE.test(s)).toBe(false);
  });

  it.each(["a", "/", "abc"])("ALL_ASCII_RE matches %s", (s) => {
    expect(ALL_ASCII_RE.test(s)).toBe(true);
  });

  it.each(["你", "a你", ""])("ALL_ASCII_RE does not match %j", (s) => {
    expect(ALL_ASCII_RE.test(s)).toBe(false);
  });

  // WI-RA17F.7 — the boundary is exactly 0x7F, whatever syntax spells it:
  // NUL and DEL are ASCII, the first C1 control is not, and astral characters
  // and lone surrogates (from a split composition) count as non-ASCII.
  it.each([
    ["NUL", "\u0000", true],
    ["DEL", "\u007f", true],
    ["U+0080", "\u0080", false],
    ["an astral emoji", "\u{1F600}", false],
    ["a lone high surrogate", "\ud83d", false],
    ["a lone low surrogate", "\ude00", false],
  ])("treats %s as ASCII = %s", (_label, s, ascii) => {
    expect(ALL_ASCII_RE.test(s)).toBe(ascii);
    expect(NON_ASCII_RE.test(s)).toBe(!ascii);
  });
});
