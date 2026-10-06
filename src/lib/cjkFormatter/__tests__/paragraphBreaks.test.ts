// @vitest-environment node
// WI-RA3.1 — no rule may delete or move a line break: a trigger split across
// a blank line (or a single newline) is two constructs, not one.
/**
 * The currency/unit rule matched the gap between its two halves with a
 * whitespace class that includes line terminators, and its replacement drops
 * the gap. `总共 100` and `% 的人投票` in separate paragraphs came back as one
 * paragraph. Each case below puts a rule's trigger on both sides of a line
 * boundary and requires the text back unchanged.
 *
 * The generated counterpart (formatting preserves the number of paragraphs and
 * of lines) lives in `idempotence.property.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { formatMarkdown } from "../formatter";
import { fixCurrencySpacing } from "../rules";
import { DEFAULT_CJK_FORMATTING, type CJKFormattingSettings } from "../types";

const ALL_ON: CJKFormattingSettings = {
  ...DEFAULT_CJK_FORMATTING,
  newlineCollapsing: true,
  fullwidthBrackets: true,
  consecutivePunctuationLimit: 2,
};

const GAPS: Array<[name: string, gap: string]> = [
  ["a blank line", "\n\n"],
  ["a single newline", "\n"],
  ["a CRLF blank line", "\r\n\r\n"],
  ["a CRLF newline", "\r\n"],
];

describe("fixCurrencySpacing never crosses a line boundary", () => {
  describe.each(GAPS)("across %s", (_name, gap) => {
    it.each([
      ["prefix currency symbol", `价格 $${gap}100 元`],
      ["prefix yen symbol", `价格 ¥${gap}100 元`],
      ["prefix currency code", `价格 USD${gap}100 元`],
      ["percent sign", `总共 100${gap}% 的人投票`],
      ["per-mille sign", `浓度 5${gap}‰ 左右`],
      ["celsius sign", `气温 30${gap}℃ 以上`],
      ["degree sign with letter", `气温 30${gap}°C 以上`],
    ])("%s", (_label, input) => {
      expect(fixCurrencySpacing(input)).toBe(input);
      expect(fixCurrencySpacing(input, "tight")).toBe(input);
    });

    it("postfix currency code in tight mode", () => {
      const input = `一共 100${gap}USD 是美元`;
      expect(fixCurrencySpacing(input, "tight")).toBe(input);
    });
  });

  it("still binds across same-line spaces and tabs", () => {
    expect(fixCurrencySpacing("$ 100")).toBe("$100");
    expect(fixCurrencySpacing("USD\t100")).toBe("USD100");
    expect(fixCurrencySpacing("50  %")).toBe("50%");
    expect(fixCurrencySpacing("100 USD", "tight")).toBe("100USD");
  });

  it("leaves a no-break space between number and unit alone", () => {
    // U+00A0 and U+202F are typed on purpose (French and SI style); they are
    // not the stray ASCII gap this rule exists to remove.
    expect(fixCurrencySpacing("50\u{a0}%")).toBe("50\u{a0}%");
    expect(fixCurrencySpacing("50\u{202f}%")).toBe("50\u{202f}%");
  });
});

describe("formatMarkdown keeps a trigger split across lines as it was", () => {
  // Already in house style on each line, so the ONLY thing a rule could do to
  // these is reach across the line boundary.
  const SPLIT_TRIGGERS: Array<[rule: string, left: string, right: string]> = [
    ["currency symbol / digit", "价格是 $", "100 元"],
    ["currency code / digit", "价格是 USD", "100 元"],
    ["digit / percent", "总共 100", "% 的人投票"],
    ["digit / celsius", "气温 30", "℃ 以上"],
    ["slash, left side", "读", "/写"],
    ["slash, right side", "读 /", "写"],
    ["ellipsis dots", "wait .", ". . 然后"],
    ["double hyphen", "中文", "-- 中文"],
    ["em-dash, left side", "中文", "—— 中文"],
    ["em-dash, right side", "中文 ——", "中文"],
    ["CJK / Latin", "中文", "English"],
    ["Latin / CJK", "English", "中文"],
    ["CJK / parenthesis", "中文", "(note)"],
    ["parenthesis / CJK", "(note)", "中文"],
    ["closing quote / CJK", "他说 “hello”", "中文"],
    ["trailing spaces before a break", "中文", "  缩进的中文"],
  ];

  describe.each(GAPS)("across %s", (_name, gap) => {
    it.each(SPLIT_TRIGGERS)("%s", (_rule, left, right) => {
      const input = `${left}${gap}${right}`;
      expect(formatMarkdown(input, DEFAULT_CJK_FORMATTING)).toBe(input);
    });
  });

  it.each(SPLIT_TRIGGERS)("%s, with every rule on", (_rule, left, right) => {
    const input = `${left}\n\n${right}`;
    expect(formatMarkdown(input, ALL_ON)).toBe(input);
  });

  it("reproduces the reported join exactly", () => {
    expect(formatMarkdown("总共 100\n\n% 的人投票", DEFAULT_CJK_FORMATTING)).toBe(
      "总共 100\n\n% 的人投票",
    );
  });
});
