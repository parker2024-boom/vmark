// @vitest-environment node
/**
 * The HTML validator must scale LINEARLY on hostile input.
 *
 * It runs synchronously in the CodeMirror lint callback, so a super-linear
 * path is a frozen editor: regex lookaheads rescanned the document per
 * unclosed `<script ` (64 KB took 0.8 s), each comment searched the rest of the
 * document for `--!>` (16,000 comments took 5.8 s), and unmatched end tags
 * searched the open-element stack.
 *
 * It asserts a GROWTH EXPONENT, never a duration — the method of
 * `utils/markdownPipeline/__tests__/pathological/pathologicalScaling.test.ts`.
 * A millisecond bound here passed locally and failed on a CI shard running
 * under coverage instrumentation; what instrumentation and contention cannot
 * do is turn cost ∝ n into cost ∝ n². CPU time of the test's own thread — not
 * of the whole process, which bills V8's background threads to whichever
 * sample runs longest (`@/test/cpuClock`) — with small and large runs
 * interleaved and the minimum of each kept, after a warm-up.
 */
import { describe, it, expect } from "vitest";
import { growthExponent, measureGrowth } from "@/test/cpuClock";
import { htmlValidator } from "./html";
import { scanHtmlTags } from "./htmlTags";

/** Linear is 1, quadratic is 2 (see the file header for the method). */
const MAX_EXPONENT = 1.35;

const encode = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const CASES: { name: string; make: (n: number) => string; run?: (html: string) => void }[] = [
  { name: "unclosed script start tags", make: (n) => "<script ".repeat(n) },
  { name: "duplicate javascript: hrefs", make: (n) => "<a " + 'href="javascript:void 0" '.repeat(n) + ">" },
  { name: "unique attributes", make: (n) => "<a " + Array.from({ length: n }, (_, i) => `data-a${i}="x"`).join(" ") + ">" },
  { name: "unterminated srcdoc openers", make: (n) => '<iframe srcdoc="'.repeat(n) + "x" },
  { name: "valid srcdoc documents", make: (n) => `<iframe srcdoc="${encode("<script>1</script>")}"></iframe>`.repeat(n) },
  { name: "deep nesting, unmatched end tags", make: (n) => "<div>".repeat(n) + "</p>".repeat(n) },
  { name: "comments", make: (n) => "<!-- x -->".repeat(n) },
  { name: "unclosed comment openers", make: (n) => "<!--".repeat(n) },
  { name: "escaped script comments", make: (n) => "<script>" + "<!-- a -->".repeat(n) + "</script>" },
  { name: "near-miss script closers", make: (n) => "<script>" + "</scriptx><scripty><!--".repeat(n) + "</script>" },
  { name: "quoted end-tag attributes", make: (n) => '</p data-x=">">'.repeat(n) },
  { name: "unterminated quoted values", make: (n) => "<a href='".repeat(n), run: (html) => void scanHtmlTags(html) },
  { name: "numeric references", make: (n) => '<a href="' + "&#115".repeat(n) + '">' },
  { name: "handlers", make: (n) => "<b onclick=x></b>".repeat(n) },
];

describe("HTML validation scales linearly on hostile input", () => {
  it.each(CASES)("$name", (c) => {
    // 4× apart: linear costs ~4×, quadratic ~16×, and the bound sits at 6.5×.
    // Larger inputs cross into allocation-heavy territory where the garbage
    // collector, not the algorithm, bends the curve.
    const small = c.make(8_000);
    const large = c.make(32_000);
    const cost = measureGrowth(c.run ?? ((html) => void htmlValidator(html)), small, large);
    const exponent = growthExponent(cost, small.length, large.length);
    expect(
      exponent,
      `${c.name}: ${small.length} chars → ${cost.smallMs.toFixed(1)}ms, ${large.length} chars → ${cost.largeMs.toFixed(1)}ms ` +
        `(exponent ${exponent.toFixed(2)} on the ${cost.clock} clock; 1 is linear, 2 is quadratic)`,
    ).toBeLessThan(MAX_EXPONENT);
  });
});
