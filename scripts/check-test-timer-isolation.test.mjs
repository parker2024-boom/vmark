// WI-RA13A.3 — the timer-isolation gate examines every test file (not only direct siblings), sees wall-clock reads and real sleeps, and its report-only switch is loud and cannot go stale
/**
 * Runs the REAL `scripts/check-test-timer-isolation.mjs --root <fixture>`
 * against fixture trees.
 *
 * Five rules, each with an id the output and the switch use:
 *   race-sibling     a test beside its subject (`x.test.ts`) can race the
 *                    subject's fire-and-forget timer;
 *   race-widened     the same race, where the test is found through a
 *                    `__tests__/` directory, a multi-dot name or `.spec.`;
 *   wall-clock-read  a test reads `Date.now()` / `new Date()` and never
 *                    controls the clock;
 *   real-sleep       a test sleeps on the wall clock for >= 100 ms;
 *   fake-timer-sleep a test sleeps, for any duration, in a file that fakes
 *                    timers.
 *
 * The SWITCH: a rule listed as report-only prints its count and every finding
 * but does not fail. It is two-way — a report-only rule with nothing left to
 * report fails the run until it is flipped to enforcing — so the switch can
 * neither be forgotten nor used to park a rule quietly.
 *
 * @coordinates-with scripts/check-test-timer-isolation.mjs — the gate under test
 * @coordinates-with scripts/check-test-timer-isolation.scan.mjs — the per-file reader
 * @module scripts/check-test-timer-isolation.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-test-timer-isolation.mjs");

/** A production module whose timer nothing awaits. */
const RACY_PROD = "export function start(cb: () => void) {\n  setTimeout(cb, 100);\n}\n";
/** An async test that never controls the clock. */
const ASYNC_TEST = 'import { it, expect } from "vitest";\nit("x", async () => {\n  await Promise.resolve();\n  expect(1).toBe(1);\n});\n';
const FAKED_TEST = 'import { it, vi } from "vitest";\nvi.useFakeTimers();\nit("x", async () => { await Promise.resolve(); });\n';
const SYNC_TEST = 'import { it, expect } from "vitest";\nit("x", () => { expect(1).toBe(1); });\n';
/** Keeps a tree non-empty without contributing a finding. */
const QUIET = { "src/quiet.ts": "export const q = 1;\n", "src/quiet.test.ts": SYNC_TEST };

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "timer-iso-"));
  for (const [rel, body] of Object.entries({ ...QUIET, ...files })) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

/** Run with every rule ENFORCED unless `reportOnly` says otherwise. */
function run(files, { reportOnly = "none", args } = {}) {
  const root = fixture(files);
  const argv = args ?? ["--report-only", reportOnly];
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, ...argv], { encoding: "utf8" });
  return { ...r, out: r.stdout + r.stderr };
}

const test = (body) => `import { it } from "vitest";\nit("x", async () => {\n${body}\n});\n`;

describe("race rules — which test files are examined", () => {
  it("a clean tree passes with every rule enforced, and reports what it scanned", () => {
    const r = run({ "src/a.ts": RACY_PROD, "src/a.test.ts": FAKED_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("2 production files, 2 test files");
    expect(r.out).toContain("race-sibling: 0");
  });

  it("a direct sibling that can race fails as race-sibling, naming both files and the timer line", () => {
    const r = run({ "src/a.ts": RACY_PROD, "src/a.test.ts": ASYNC_TEST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("race-sibling: 1");
    expect(r.out).toContain("src/a.test.ts races src/a.ts (fire-and-forget timer at line 2)");
  });

  it.each([
    ["a __tests__ directory", "src/feature/__tests__/a.test.ts"],
    ["a multi-dot name", "src/feature/a.lifecycle.test.ts"],
    ["a multi-dot name with two extra segments", "src/feature/a.edge.cases.test.tsx"],
    ["a multi-dot name inside __tests__", "src/feature/__tests__/a.lifecycle.test.tsx"],
    ["a .spec file", "src/feature/a.spec.ts"],
    ["a .tsx test of a .ts subject", "src/feature/__tests__/a.test.tsx"],
  ])("a test reached through %s is examined", (_label, testPath) => {
    const r = run({ "src/feature/a.ts": RACY_PROD, [testPath]: ASYNC_TEST });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("race-widened: 1");
    expect(r.out).toContain(`${testPath} races src/feature/a.ts`);
  });

  it("every test file of one subject is judged on its own", () => {
    const r = run({
      "src/a.ts": RACY_PROD,
      "src/a.test.ts": FAKED_TEST,
      "src/a.test.tsx": ASYNC_TEST,
      "src/a.other.test.ts": ASYNC_TEST,
      "src/__tests__/a.test.ts": FAKED_TEST,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("race-sibling: 1");
    expect(r.out).toContain("src/a.test.tsx races src/a.ts");
    expect(r.out).toContain("race-widened: 1");
    expect(r.out).toContain("src/a.other.test.ts races src/a.ts");
    expect(r.out).not.toContain("src/a.test.ts races");
  });

  it("a multi-dot test pairs with the LONGEST matching subject name", () => {
    const r = run({
      "src/schemas.ts": "export const s = 1;\n",
      "src/schemas.browser.ts": RACY_PROD,
      "src/schemas.browser.test.ts": ASYNC_TEST,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/schemas.browser.test.ts races src/schemas.browser.ts");
    expect(r.out).toContain("race-sibling: 1");
  });

  it("a .tsx subject is paired too", () => {
    const r = run({ "src/View.tsx": RACY_PROD, "src/__tests__/View.test.tsx": ASYNC_TEST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("races src/View.tsx");
  });

  it("a test that pairs with no production file is counted, not silently dropped", () => {
    const r = run({ "src/__tests__/integration.test.ts": ASYNC_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("1 unpaired");
  });
});

describe("race rules — what counts as a race", () => {
  const racing = (testBody) => ({ "src/a.ts": RACY_PROD, "src/a.test.ts": testBody });

  it.each([
    ["an awaited timer", "export async function f() {\n  await setTimeout(() => {}, 5);\n}\n"],
    ["a returned timer", "export function f() {\n  return setTimeout(() => {}, 5);\n}\n"],
    ["the sleep idiom", "export const sleep = (n: number) => new Promise((r) => setTimeout(r, n));\n"],
    ["a timeout guard", "export const guard = () => new Promise((_, reject) => setTimeout(reject, 5));\n"],
    ["no timer at all", "export const f = () => 1;\n"],
  ])("a subject with %s is not racy", (_label, prod) => {
    const r = run({ "src/a.ts": prod, "src/a.test.ts": ASYNC_TEST });
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ["setInterval", "export function f(cb: () => void) {\n  setInterval(cb, 50);\n}\n"],
    ["window.setTimeout", "export function f(cb: () => void) {\n  window.setTimeout(cb, 50);\n}\n"],
  ])("a fire-and-forget %s is racy", (_label, prod) => {
    const r = run({ "src/a.ts": prod, "src/a.test.ts": ASYNC_TEST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("race-sibling: 1");
  });

  it("a synchronous test cannot be interleaved, so it passes", () => {
    expect(run(racing(SYNC_TEST)).status).toBe(0);
  });

  it("a test that calls useFakeTimers passes", () => {
    expect(run(racing(FAKED_TEST)).status).toBe(0);
  });

  it("useRealTimers alone does not count — it is the cleanup half of the pattern", () => {
    const r = run(racing('import { it, vi } from "vitest";\nvi.useRealTimers();\nit("x", async () => { await 1; });\n'));
    expect(r.status).toBe(1);
  });

  it("useFakeTimers mentioned only in a comment or a string does not count", () => {
    const body = '// remember to call vi.useFakeTimers()\nconst hint = "vi.useFakeTimers()";\n' + ASYNC_TEST;
    const r = run(racing(body));
    expect(r.status).toBe(1);
  });

  it("the opt-out marker with a reason passes", () => {
    const r = run(racing("// timer-isolation: intentional real timers — the poll loop is the subject\n" + ASYNC_TEST));
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ["with no reason", "// timer-isolation: intentional real timers —\n"],
    ["with no dash", "// timer-isolation: intentional real timers\n"],
    ["inside a string", 'const s = "timer-isolation: intentional real timers — sure";\n'],
  ])("the opt-out marker %s does not opt out", (_label, line) => {
    const r = run(racing(line + ASYNC_TEST));
    expect(r.status).toBe(1);
  });

  it("CRLF line endings do not hide the marker or the race", () => {
    const crlf = (s) => s.replaceAll("\n", "\r\n");
    expect(run({ "src/a.ts": crlf(RACY_PROD), "src/a.test.ts": crlf(ASYNC_TEST) }).status).toBe(1);
    const marked = crlf("// timer-isolation: intentional real timers — 理由 here\n" + ASYNC_TEST);
    expect(run({ "src/a.ts": crlf(RACY_PROD), "src/a.test.ts": marked }).status).toBe(0);
  });
});

describe("wall-clock-read", () => {
  it.each([
    ["Date.now()", "  const t = Date.now();", "Date.now()"],
    ["new Date()", "  const d = new Date();", "new Date()"],
    ["new Date with no parentheses", "  const d = new Date;", "new Date()"],
  ])("%s with no fake clock is reported with file and line", (_label, line, what) => {
    const r = run({ "src/__tests__/t.test.ts": test(line) });
    expect(r.status).toBe(1);
    expect(r.out).toContain("wall-clock-read: 1");
    expect(r.out).toContain(`src/__tests__/t.test.ts:3  ${what}`);
  });

  it.each([
    ["an explicit instant", "  const d = new Date(0);"],
    ["a parsed date", '  const d = new Date("2026-01-01T00:00:00Z");'],
    ["a mention in a comment", "  // Date.now() would be flaky here"],
    ["a mention in a string", '  const s = "Date.now() and new Date()";'],
    ["a different object's now()", "  const t = performance.now();"],
    ["Date.UTC", "  const t = Date.UTC(2026, 0, 1);"],
  ])("%s is not a wall-clock read", (_label, line) => {
    const r = run({ "src/t.test.ts": test(line) });
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ["vi.useFakeTimers()", "vi.useFakeTimers();"],
    ["vi.setSystemTime()", "vi.setSystemTime(0);"],
    ['vi.spyOn(Date, "now")', 'vi.spyOn(Date, "now").mockReturnValue(1);'],
  ])("a file that controls the clock with %s may read it", (_label, control) => {
    const body = `import { it, vi } from "vitest";\n${control}\nit("x", () => { const t = Date.now(); void t; });\n`;
    const r = run({ "src/t.test.ts": body });
    expect(r.status, r.out).toBe(0);
  });

  it("the wall-clock marker with a reason opts the file out; the real-timers marker does not", () => {
    const read = test("  const t = Date.now();");
    expect(run({ "src/t.test.ts": "// timer-isolation: intentional wall clock — measures elapsed time\n" + read }).status).toBe(0);
    expect(run({ "src/t.test.ts": "// timer-isolation: intentional real timers — unrelated\n" + read }).status).toBe(1);
  });

  it("reports every read, and counts files as well as reads", () => {
    const r = run({
      "src/a.test.ts": test("  const a = Date.now();\n  const b = new Date();"),
      "src/b.test.tsx": test("  const c = Date.now();"),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("wall-clock-read: 3 in 2 file(s)");
    expect(r.out).toContain("src/a.test.ts:3  Date.now()");
    expect(r.out).toContain("src/a.test.ts:4  new Date()");
    expect(r.out).toContain("src/b.test.tsx:3  Date.now()");
  });
});

describe("real-sleep", () => {
  const sleeping = (line) => ({ "src/feature/__tests__/s.test.ts": test(line) });

  it.each([
    ["the inline idiom", "  await new Promise((r) => setTimeout(r, 200));", 200],
    ["exactly the threshold", "  await new Promise((r) => setTimeout(r, 100));", 100],
    ["a resolver with another name", "  await new Promise((resolve) => setTimeout(resolve, 150));", 150],
    ["a typed promise", "  await new Promise<void>((resolve) => setTimeout(resolve, 150));", 150],
    ["a function executor", "  await new Promise(function (done) { setTimeout(done, 300); });", 300],
    ["a wrapped resolve call", "  await new Promise((resolve) => setTimeout(() => resolve(undefined), 250));", 250],
    ["window.setTimeout", "  await new Promise((r) => window.setTimeout(r, 120));", 120],
    ["a numeric separator", "  await new Promise((r) => setTimeout(r, 1_000));", 1000],
    ["a sleep that is not awaited", "  const p = new Promise((r) => setTimeout(r, 400)); void p;", 400],
  ])("%s is reported with its duration", (_label, line, ms) => {
    const r = run(sleeping(line));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("real-sleep: 1");
    expect(r.out).toContain(`src/feature/__tests__/s.test.ts:3  ${ms}ms`);
  });

  it.each([
    ["one millisecond under the threshold", "  await new Promise((r) => setTimeout(r, 99));"],
    ["a zero-delay tick", "  await new Promise((r) => setTimeout(r, 0));"],
    ["a delay with no duration", "  await new Promise((r) => setTimeout(r));"],
    ["a duration that is not a literal", "  const n = 500;\n  await new Promise((r) => setTimeout(r, n));"],
    ["a timeout guard", "  await Promise.race([Promise.resolve(), new Promise((_, reject) => setTimeout(reject, 5000))]);"],
    ["a mention in a string", '  const s = "await new Promise((r) => setTimeout(r, 200))";'],
    ["a mention in a comment", "  // await new Promise((r) => setTimeout(r, 200));"],
    ["a bare fire-and-forget timer", "  setTimeout(() => {}, 500);"],
  ])("%s is not reported", (_label, line) => {
    const r = run(sleeping(line));
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ["an arrow helper", "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));"],
    ["a function helper", "function sleep(ms: number) {\n  return new Promise<void>((resolve) => setTimeout(resolve, ms));\n}"],
    ["a helper whose duration is its second parameter", "const sleep = (_label: string, ms: number) => new Promise((r) => setTimeout(r, ms));"],
  ])("a call to %s defined in the file is a sleep", (label, helper) => {
    const call = label.includes("second") ? 'await sleep("x", 250);' : "await sleep(250);";
    const body = `import { it } from "vitest";\n${helper}\nit("x", async () => {\n  ${call}\n});\n`;
    const r = run({ "src/s.test.ts": body });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("real-sleep: 1");
    expect(r.out).toMatch(/src\/s\.test\.ts:\d+ {2}250ms/);
  });

  // WI-RA13B.7 — a sleep helper shared from a test utility is followed through
  // the import, so moving the idiom into a helper cannot hide it.
  describe("a sleep helper imported from a shared test utility", () => {
    const SHARED = "export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n" +
      "export function pause(_why: string, ms: number) {\n  return new Promise<void>((resolve) => setTimeout(resolve, ms));\n}\n" +
      "export const notASleep = (ms: number) => ms;\n";
    const importing = (spec, names, call) =>
      `import { it } from "vitest";\nimport { ${names} } from "${spec}";\nit("x", async () => {\n  ${call}\n});\n`;

    it.each([
      ["a relative import", "../test/timing", "sleep", "await sleep(250);"],
      ["the @/ alias", "@/test/timing", "sleep", "await sleep(250);"],
      ["an aliased name", "@/test/timing", "sleep as nap", "await nap(250);"],
      ["a duration in the second parameter", "@/test/timing", "pause", 'await pause("x", 250);'],
      ["a re-export through an index module", "@/test", "sleep", "await sleep(250);"],
    ])("%s is followed and the call is a sleep", (_label, spec, names, call) => {
      const r = run({
        "src/test/timing.ts": SHARED,
        "src/test/index.ts": 'export { sleep } from "./timing";\n',
        "src/feature/s.test.ts": importing(spec, names, call),
      });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("real-sleep: 1");
      expect(r.out).toContain("src/feature/s.test.ts:4  250ms");
    });

    it("an index module declaring the helper itself is followed", () => {
      const r = run({
        "src/test/index.ts": "export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n",
        "src/feature/s.test.ts": importing("@/test", "sleep", "await sleep(300);"),
      });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("src/feature/s.test.ts:4  300ms");
    });

    it("an imported non-sleep, a short sleep and an unresolvable import are not reported", () => {
      const r = run({
        "src/test/timing.ts": SHARED,
        "src/feature/s.test.ts": importing("@/test/timing", "notASleep, sleep", "notASleep(500);\n  await sleep(20);") +
          'import { sleep as other } from "./missing";\nit("y", async () => { await other(900); });\n',
      });
      expect(r.status, r.out).toBe(0);
    });
  });

  it("a helper called under the threshold, or with a non-literal, is not reported", () => {
    const body =
      'import { it } from "vitest";\nconst sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n' +
      'it("x", async () => {\n  await sleep(20);\n  const n = 900;\n  await sleep(n);\n});\n';
    expect(run({ "src/s.test.ts": body }).status).toBe(0);
  });


  it("a file that only mocks Date still sleeps on the real timers", () => {
    const body = 'import { it, vi } from "vitest";\nvi.setSystemTime(0);\nit("x", async () => {\n  await new Promise((r) => setTimeout(r, 200));\n});\n';
    const r = run({ "src/s.test.ts": body });
    expect(r.status).toBe(1);
    expect(r.out).toContain("real-sleep: 1 in 1 file(s)");
  });

  it("the real-timers marker with a reason opts the file out", () => {
    const body = "// timer-isolation: intentional real timers — exercises the real debounce\n" + test("  await new Promise((r) => setTimeout(r, 200));");
    expect(run({ "src/s.test.ts": body }).status).toBe(0);
  });

  it("test files under server/ and website/ are examined as well as src/", () => {
    const r = run({
      "server/mcp/__tests__/unit/ws.test.ts": test("  await new Promise((r) => setTimeout(r, 200));"),
      "website/.vitepress/theme/x.test.ts": test("  const t = Date.now();"),
      "server/mcp/node_modules/dep/x.test.ts": test("  await new Promise((r) => setTimeout(r, 900));"),
      "server/mcp/dist/x.test.ts": test("  await new Promise((r) => setTimeout(r, 900));"),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("server/mcp/__tests__/unit/ws.test.ts:3  200ms");
    expect(r.out).toContain("website/.vitepress/theme/x.test.ts:3  Date.now()");
    expect(r.out).not.toContain("node_modules");
    expect(r.out).not.toContain("dist/x.test.ts");
  });

  it("lists every sleep, longest first within the listing order of files", () => {
    const r = run(sleeping("  await new Promise((r) => setTimeout(r, 200));\n  await new Promise((r) => setTimeout(r, 300));"));
    expect(r.out).toContain("real-sleep: 2 in 1 file(s)");
    expect(r.out).toContain("s.test.ts:3  200ms");
    expect(r.out).toContain("s.test.ts:4  300ms");
  });
});

// WI-RA24.8 — a sleep in a file that fakes timers is a mistake at ANY duration:
// either it waits on fake timers that nothing advances, or it runs where the
// file switched back to real ones and sleeps on the wall clock. Advance the
// fake clock (`vi.advanceTimersByTimeAsync`) or await the condition instead.
describe("fake-timer-sleep", () => {
  const faked = (call, helper = "") =>
    `import { it, vi } from "vitest";\n${helper}vi.useFakeTimers();\nit("x", async () => {\n  ${call}\n});\n`;

  it.each([
    ["a long sleep", "await new Promise((r) => setTimeout(r, 200));", ""],
    ["a short sleep, under the real-sleep threshold", "await new Promise((r) => setTimeout(r, 10));", ""],
    ["a zero-length sleep", "await new Promise((r) => setTimeout(r, 0));", ""],
    ["a sleep through a helper", "await sleep(50);", "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n"],
  ])("flags %s, whatever its length", (_label, call, helper) => {
    const r = run({ "src/s.test.ts": faked(call, helper) });
    expect(r.status).toBe(1);
    expect(r.out).toContain("fake-timer-sleep: 1 in 1 file(s)");
    expect(r.out).toContain("  real-sleep: 0\n");
  });

  it("advancing the fake clock is not a sleep", () => {
    const r = run({ "src/s.test.ts": faked("await vi.advanceTimersByTimeAsync(200);") });
    expect(r.status).toBe(0);
  });

  it("a delayed promise handed on, not awaited where written, is not a sleep", () => {
    // A mock's slow result: fake timers advance it like any other timer.
    const call =
      "const slow = vi.fn(() => new Promise((r) => setTimeout(r, 5000)));\n" +
      "  const pending = slow();\n  await vi.advanceTimersByTimeAsync(5000);\n  await pending;";
    expect(run({ "src/s.test.ts": faked(call) }).status).toBe(0);
  });

  it("a sleep awaited through parentheses is still a sleep", () => {
    const r = run({ "src/s.test.ts": faked("await (new Promise((r) => setTimeout(r, 5)));") });
    expect(r.out).toContain("fake-timer-sleep: 1 in 1 file(s)");
  });

  it("the real-timers marker with a reason opts the file out", () => {
    const body =
      "// timer-isolation: intentional real timers — measures the real debounce\n" +
      faked("await new Promise((r) => setTimeout(r, 30));");
    expect(run({ "src/s.test.ts": body }).status).toBe(0);
  });

  it("names the file, the line and the duration", () => {
    const r = run({ "src/s.test.ts": faked("await new Promise((r) => setTimeout(r, 30));") });
    expect(r.out).toContain("src/s.test.ts:4  30ms");
  });
});


describe("the report-only switch", () => {
  const VIOLATING = {
    "src/a.ts": RACY_PROD,
    "src/__tests__/a.test.ts": ASYNC_TEST,
    "src/c.test.ts": test("  const t = Date.now();"),
    "src/s.test.ts": test("  await new Promise((r) => setTimeout(r, 200));"),
  };
  const ALL_THREE = "race-widened,wall-clock-read,real-sleep";

  it("a report-only rule does not fail, and prints its count and EVERY finding", () => {
    const r = run(VIOLATING, { reportOnly: ALL_THREE });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("REPORT-ONLY");
    expect(r.out).toContain("race-widened: 1");
    expect(r.out).toContain("src/__tests__/a.test.ts races src/a.ts");
    expect(r.out).toContain("wall-clock-read: 1 in 1 file(s)");
    expect(r.out).toContain("src/c.test.ts:3  Date.now()");
    expect(r.out).toContain("real-sleep: 1 in 1 file(s)");
    expect(r.out).toContain("src/s.test.ts:3  200ms");
    expect(r.out).toContain("3 finding(s) in report-only rules are NOT failing this run");
  });

  it("the same tree fails once the rules are enforced", () => {
    const r = run(VIOLATING, { reportOnly: "none" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("3 finding(s) in enforced rules");
  });

  it("the switch is per rule", () => {
    const r = run(VIOLATING, { reportOnly: "race-widened,wall-clock-read" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("1 finding(s) in enforced rules");
    expect(r.out).toContain("2 finding(s) in report-only rules are NOT failing this run");
  });

  it("race-sibling cannot be hidden behind the other rules being report-only", () => {
    const r = run({ ...VIOLATING, "src/b.ts": RACY_PROD, "src/b.test.ts": ASYNC_TEST }, { reportOnly: ALL_THREE });
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/b.test.ts races src/b.ts");
  });

  it("a report-only rule with NOTHING left to report fails until it is flipped to enforcing", () => {
    const { "src/s.test.ts": _fixed, ...rest } = VIOLATING;
    const r = run(rest, { reportOnly: ALL_THREE });
    expect(r.status).toBe(1);
    expect(r.out).toContain("real-sleep is report-only but has no findings");
    expect(r.out).toContain("REPORT_ONLY_RULES");
  });

  it("an unknown rule name in the switch is a usage error", () => {
    const r = run(VIOLATING, { reportOnly: "real-sleeps" });
    expect(r.status).toBe(64);
    expect(r.out).toContain("unknown rule: real-sleeps");
  });

  it("with no flag the script uses its committed REPORT_ONLY_RULES: every rule fails", () => {
    const r = run(VIOLATING, { args: [] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("3 finding(s) in enforced rules");
    expect(r.out).not.toContain("REPORT-ONLY");
  });

  // The committed state of the switch. Flipping a rule to enforcing is a
  // one-line change in the gate AND a change here, so it is a reviewed diff.
  it("PIN: no rule is report-only today — all five are enforced", async () => {
    const { REPORT_ONLY_RULES, RULES } = await import("./check-test-timer-isolation.mjs");
    expect(RULES).toEqual(["race-sibling", "race-widened", "wall-clock-read", "real-sleep", "fake-timer-sleep"]);
    expect(REPORT_ONLY_RULES).toEqual([]);
  });

  it("the repository itself has no finding under any rule", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--report-only", "none"], { encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    for (const rule of ["race-sibling", "race-widened", "wall-clock-read", "real-sleep", "fake-timer-sleep"]) {
      expect(r.stdout).toContain(`  ${rule}: 0\n`);
    }
  });

  it("the wired-in gate passes no flag of its own — the switch lives in one place", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    expect(pkg.scripts["lint:timer-isolation"]).toBe("node scripts/check-test-timer-isolation.mjs");
  });
});

describe("a tree it could not read never passes", () => {
  const bare = (files) => {
    const root = mkdtempSync(path.join(tmpdir(), "timer-iso-bare-"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    }
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root, "--report-only", "none"], { encoding: "utf8" });
    return { ...r, out: r.stdout + r.stderr };
  };

  it("no src/ directory fails", () => {
    const r = bare({ "lib/a.ts": "export const a = 1;\n" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/ not found");
  });

  it("a tree with no test file fails", () => {
    const r = bare({ "src/a.ts": "export const a = 1;\n" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("0 test files");
  });

  it("a tree with no production file fails", () => {
    const r = bare({ "src/a.test.ts": SYNC_TEST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("0 production files");
  });

  it("a test file that does not parse is a failure, named", () => {
    const r = run({ "src/broken.test.ts": 'it("x", async () => { await new Promise((r) => setTimeout(r, 200)\n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/broken.test.ts");
    expect(r.out).toContain("does not parse");
  });

  it("an unknown argument is a usage error", () => {
    const r = run({}, { args: ["--fix"] });
    expect(r.status).toBe(64);
  });
});
