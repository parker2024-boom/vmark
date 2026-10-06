// @vitest-environment node
// WI-RA10A.12 — truncation never splits a surrogate pair or a grapheme
// cluster, and never returns more than the budget.
import { describe, it, expect, afterEach, vi } from "vitest";
import { truncateToLength } from "./truncateText";

/** A lone surrogate: the thing `slice` produces and serde refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const GRIN = "\u{1F600}"; // 😀 — one code point, two UTF-16 units
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 👨‍👩‍👧 — one grapheme, 8 units
const FLAG = "\u{1F1EF}\u{1F1F5}"; // 🇯🇵 — two regional indicators, 4 units
const THUMB = "\u{1F44D}\u{1F3FD}"; // 👍🏽 — emoji + skin tone, 4 units
const E_ACUTE = "é"; // é as base + combining mark, 2 units
const RARE_HAN = "\u{20BB7}"; // 𠮷 — supplementary-plane Han, 2 units
const HANGUL_JAMO = "한"; // 한 as three conjoining jamo

describe("truncateToLength", () => {
  it.each([
    { name: "returns short text untouched", text: "hello", max: 80, want: "hello" },
    { name: "returns text exactly at the budget untouched", text: "hello", max: 5, want: "hello" },
    { name: "cuts plain ASCII at the budget", text: "hello world", max: 5, want: "hello" },
    { name: "handles the empty string", text: "", max: 5, want: "" },
    { name: "cuts BMP CJK per character", text: "你好世界", max: 2, want: "你好" },
  ])("$name", ({ text, max, want }) => {
    expect(truncateToLength(text, max)).toBe(want);
  });

  it.each([
    { name: "an emoji straddling the budget is dropped whole", text: `ab${GRIN}cd`, max: 3, want: "ab" },
    { name: "an emoji that fits exactly is kept", text: `ab${GRIN}cd`, max: 4, want: `ab${GRIN}` },
    { name: "a supplementary-plane Han character is not halved", text: `a${RARE_HAN}b`, max: 2, want: "a" },
    { name: "a ZWJ family is not cut between its members", text: `a${FAMILY}b`, max: 5, want: "a" },
    { name: "a ZWJ family that fits is kept whole", text: `a${FAMILY}b`, max: 9, want: `a${FAMILY}` },
    { name: "a flag is not cut between its regional indicators", text: `a${FLAG}b`, max: 3, want: "a" },
    { name: "a skin-tone modifier stays with its emoji", text: `a${THUMB}b`, max: 3, want: "a" },
    { name: "a combining mark stays with its base letter", text: `caf${E_ACUTE}s`, max: 4, want: "caf" },
    { name: "conjoining Hangul jamo stay one syllable", text: `a${HANGUL_JAMO}b`, max: 2, want: "a" },
  ])("$name", ({ text, max, want }) => {
    const result = truncateToLength(text, max);
    expect(result).toBe(want);
    expect(result).not.toMatch(LONE_SURROGATE);
  });

  it("never exceeds the budget and never emits a lone surrogate, at every cut point", () => {
    const text = `x${GRIN}${FAMILY}你${E_ACUTE}${FLAG}${RARE_HAN}${THUMB}y`;
    for (let max = 0; max <= text.length + 1; max += 1) {
      const result = truncateToLength(text, max);
      expect(result.length).toBeLessThanOrEqual(max);
      expect(text.startsWith(result)).toBe(true);
      expect(result).not.toMatch(LONE_SURROGATE);
    }
  });

  it("is monotonic: a larger budget never yields a shorter prefix", () => {
    const text = `${FAMILY}${FLAG}a${GRIN}${E_ACUTE}`;
    let previous = 0;
    for (let max = 0; max <= text.length; max += 1) {
      const length = truncateToLength(text, max).length;
      expect(length).toBeGreaterThanOrEqual(previous);
      previous = length;
    }
  });

  it("falls back to a code-point cut when one grapheme alone exceeds the budget", () => {
    // 8 units of family emoji, budget 5: no grapheme boundary fits. An empty
    // result would discard a name that is nothing but this emoji, so the cut
    // lands on the last whole code point instead — still well-formed.
    const result = truncateToLength(FAMILY, 5);
    expect(result).toBe("\u{1F468}‍\u{1F469}");
    expect(result).not.toMatch(LONE_SURROGATE);
  });

  it("returns nothing when even one code point does not fit", () => {
    expect(truncateToLength(GRIN, 1)).toBe("");
  });

  it.each([0, -1, Number.NaN, Number.NEGATIVE_INFINITY])("returns nothing for a budget of %s", (max) => {
    expect(truncateToLength("hello", max)).toBe("");
  });

  it("returns the whole text for an infinite budget", () => {
    expect(truncateToLength(`a${GRIN}`, Number.POSITIVE_INFINITY)).toBe(`a${GRIN}`);
  });

  it("treats a fractional budget as its floor", () => {
    expect(truncateToLength("hello", 3.9)).toBe("hel");
  });

  it("does not make an already ill-formed string worse", () => {
    // Input damaged upstream: a lone high surrogate. Nothing to repair here,
    // but the cut must not throw and must not move past the budget.
    const result = truncateToLength("ab\uD83Dcd", 4);
    expect(result).toBe("ab\uD83Dc");
  });

  it("looks only at the prefix: cost does not grow with the text behind it", () => {
    // A megabyte of text behind the cut must not be handed to the segmenter.
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    try {
      truncateToLength(`ab${GRIN}${"z".repeat(1_000_000)}`, 3);
      const seen = segment.mock.calls.map(([input]) => input.length);
      expect(seen.length).toBeGreaterThan(0);
      expect(Math.max(...seen)).toBeLessThanOrEqual(8);
    } finally {
      segment.mockRestore();
    }
  });
});

describe("truncateToLength without Intl.Segmenter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadWithoutSegmenter() {
    vi.resetModules();
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    return (await import("./truncateText")).truncateToLength;
  }

  it("still never splits a surrogate pair", async () => {
    const truncate = await loadWithoutSegmenter();
    expect(truncate(`ab${GRIN}cd`, 3)).toBe("ab");
    expect(truncate(`ab${GRIN}cd`, 4)).toBe(`ab${GRIN}`);
  });

  it("cuts on code points, so a cluster may be shortened but stays well-formed", async () => {
    const truncate = await loadWithoutSegmenter();
    const result = truncate(`a${FAMILY}b`, 5);
    expect(result).toBe("a\u{1F468}‍");
    expect(result).not.toMatch(LONE_SURROGATE);
  });
});
