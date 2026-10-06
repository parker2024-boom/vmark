// @vitest-environment node
/**
 * Audit 20260804-F5 — fullwidth punctuation normalization must be linear-ish.
 *
 * The fixed-point wrapper used to rescan the ENTIRE document (Latin-span scan
 * included) once per converted character, because each scan read its left
 * neighbour from the original text and so could only ever advance the
 * conversion front by one. On a long punctuation run in CJK context that is
 * Θ(N²) — and the formatter is synchronous, called from "Format CJK File" and
 * from paste, so the cost lands on the UI thread as a freeze.
 *
 * WI-RA14A.2 — it asserts a GROWTH EXPONENT, never a duration: the method of
 * `lib/formats/adapters/htmlScaling.test.ts`. It used to hold an absolute
 * 2 s wall-clock budget, which measures how busy the machine is as much as
 * the algorithm; an exponent measured on the test thread's own CPU clock
 * (`@/test/cpuClock`) is what contention and coverage instrumentation cannot
 * move, because neither turns cost ∝ n into cost ∝ n².
 *
 * Sizes stay at 2k → 8k: past ~64k chars the timing turns over (0.25 → 1.11
 * ms/1k at 96k) on V8 string representation, not on this algorithm, so a
 * bigger sample measures the engine instead.
 *
 * The output assertions matter as much as the growth: "fast" is easy if you
 * stop converting.
 */
import { describe, expect, it } from "vitest";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { normalizeFullwidthPunctuation } from "./fullwidth";

/** Linear is 1, quadratic is 2; 4x the input under a quadratic law is ~16x the work. */
const MAX_EXPONENT = 1.35;
const SMALL = 2_000;
const LARGE = 8_000;

const MARKS = ",.!?;:";
const mixedRun = (n: number) => Array.from({ length: n }, (_, i) => MARKS[i % MARKS.length]).join("");

const CASES: { name: string; make: (n: number) => string }[] = [
  { name: "a comma run after a CJK char", make: (n) => `中${",".repeat(n)}` },
  { name: "a mixed run of every convertible mark", make: (n) => `中${mixedRun(n)}` },
  { name: "an ASCII-only comma run", make: (n) => ",".repeat(n) },
];

describe("normalizeFullwidthPunctuation output on long runs", () => {
  it("converts every comma of a 10k run after a CJK char", () => {
    // Each comma's left neighbour is the comma before it, which is itself CJK
    // terminal punctuation once converted.
    expect(normalizeFullwidthPunctuation(`中${",".repeat(10_000)}`)).toBe(`中${"，".repeat(10_000)}`);
  });

  it("converts a mixed 10k run of every convertible mark", () => {
    const output = normalizeFullwidthPunctuation(`中${mixedRun(10_000)}`);

    expect(output).not.toContain(",");
    expect(output.startsWith("中，。！？；：")).toBe(true);
  });

  it("leaves a long ASCII-only run untouched", () => {
    const input = ",".repeat(10_000);
    expect(normalizeFullwidthPunctuation(input)).toBe(input);
  });

  it("still protects technical subspans inside a long document", () => {
    // The speed-up must not come from skipping the guards.
    const filler = `中${",".repeat(5_000)}`;
    const output = normalizeFullwidthPunctuation(`${filler}\n中文 https://example.com/a,b 结束`);

    expect(output).toContain("https://example.com/a,b");
    expect(output.startsWith(`中${"，".repeat(5_000)}`)).toBe(true);
  });

  it("is idempotent on the adversarial input", () => {
    const once = normalizeFullwidthPunctuation(`中${",".repeat(5_000)}`);
    expect(normalizeFullwidthPunctuation(once)).toBe(once);
  });
});

describe("normalizeFullwidthPunctuation scales linearly", () => {
  it.each(CASES)("$name", (c) => {
    const small = c.make(SMALL);
    const large = c.make(LARGE);
    const cost = measureGrowth((s: string) => void normalizeFullwidthPunctuation(s), small, large);
    const exponent = growthExponent(cost, small.length, large.length);
    expect(
      exponent,
      `${c.name}: ${small.length} chars → ${cost.smallMs.toFixed(2)}ms, ${large.length} chars → ` +
        `${cost.largeMs.toFixed(2)}ms (exponent ${exponent.toFixed(2)} on the ${cost.clock} clock)`,
    ).toBeLessThan(MAX_EXPONENT);
  });
});
