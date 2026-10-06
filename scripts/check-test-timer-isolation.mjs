#!/usr/bin/env node
/**
 * check-test-timer-isolation — fail when a test depends on the wall clock.
 *
 * ## The defect this exists for
 *
 * `useUpdateSync` scheduled a fire-and-forget `setTimeout(.., 100)` on mount
 * that emitted an event. Its test asserted `expect(emitMock).not
 * .toHaveBeenCalled()`. In isolation the assertion ran well inside 100 ms and
 * passed 3/3; under full-suite parallel load an `act()` block exceeded it, the
 * timer fired between the mock reset and the assertion, and `check:all` went
 * red on a test that had nothing to do with the change being made.
 *
 * That is not flakiness in the "computers are mysterious" sense. It is a test
 * whose outcome a wall-clock timer can change, without controlling the clock —
 * a structural property, visible without running anything.
 *
 * ## Rules
 *
 *   race-sibling     `x.test.ts(x)` beside `x.ts(x)`: the subject schedules a
 *                    FIRE-AND-FORGET timer, the test has async bodies, and the
 *                    test never calls `useFakeTimers()`.
 *   race-widened     the same race, for a test found through a `__tests__/`
 *                    directory, a multi-dot name (`x.lifecycle.test.tsx`) or
 *                    `.spec.`. Pairing used to stop at the direct sibling, so
 *                    most test files were never examined at all.
 *   wall-clock-read  a test calls `Date.now()` or `new Date()` and nothing in
 *                    the file controls the clock.
 *   real-sleep       a test sleeps on the wall clock for >= 100 ms
 *                    (`await new Promise(r => setTimeout(r, N))`, or a sleep
 *                    helper declared in the file or imported from a shared
 *                    test utility) with no fake timers. A mocked Date alone
 *                    leaves the timers real, so it does not excuse a sleep.
 *   fake-timer-sleep a test awaits a sleep, for ANY duration, in a file that
 *                    fakes timers: either it waits on fake timers nothing
 *                    advances, or it runs where the file switched back to real
 *                    ones. Advance the fake clock or await the condition
 *                    instead. A delayed promise handed on (a mock's slow
 *                    result) is not a sleep there: fake timers advance it.
 *
 * An `await`ed or returned timer in the SUBJECT is deterministic — the
 * awaiting code decides when it resumes — and does not make it racy. A fully
 * synchronous test cannot be interleaved by any timer.
 *
 * ## Opting out
 *
 * A file that genuinely needs the real thing says so, with a reason, in a line
 * comment: `// timer-isolation: intentional real timers — <reason>` (race
 * rules and real-sleep) or `// timer-isolation: intentional wall clock —
 * <reason>` (wall-clock-read). Deliberately NOT `vi.useRealTimers()`: that
 * call is the cleanup half of the fake-timer pattern and appears in nearly
 * every file that fakes the clock.
 *
 * ## The report-only switch
 *
 * `REPORT_ONLY_RULES` lists rules whose findings are printed — count and every
 * finding, on every run — but do not fail. It exists so a rule can land before
 * the last of its findings is fixed. It is two-way: a report-only rule with no
 * findings left FAILS the run until its name is removed from the list, so the
 * switch cannot outlive its reason. The list is empty today — all five rules
 * fail the run. `--report-only <a,b|none>` overrides the list for this gate's
 * own tests.
 *
 * Usage: node scripts/check-test-timer-isolation.mjs [--root <dir>] [--report-only <rules|none>]
 *
 * @coordinates-with scripts/check-test-timer-isolation.scan.mjs — reads one test file's clock usage
 * @coordinates-with scripts/lib/timerIsolationImports.mjs — follows imported sleep helpers
 * @coordinates-with scripts/check-test-timer-isolation.test.mjs — runs this against fixture trees
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/isMainModule.mjs";
import { scanTestClockUsage } from "./check-test-timer-isolation.scan.mjs";
import { importedSleepHelpers } from "./lib/timerIsolationImports.mjs";

export const RULES = ["race-sibling", "race-widened", "wall-clock-read", "real-sleep", "fake-timer-sleep"];

/**
 * Rules that report without failing. Empty: every rule is enforced. A new rule
 * may be listed here while its findings are being fixed, and no longer.
 */
export const REPORT_ONLY_RULES = [];

/** A sleep shorter than this is a tick, not a wait on the wall clock. */
export const SLEEP_THRESHOLD_MS = 100;

/** Subjects live in `src/`; tests are read wherever a vitest tier collects them. */
const PROD_ROOT = "src";
const TEST_ROOTS = ["src", "server", "website"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "target"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const SOURCE_FILE = /\.tsx?$/;

const marker = (what) => new RegExp(`^[ \\t]*//[ \\t]*timer-isolation:[ \\t]*intentional ${what}[ \\t]*—[ \\t]*\\S`, "m");
const REAL_TIMERS_MARKER = marker("real timers");
const WALL_CLOCK_MARKER = marker("wall clock");

/** Lines of timers whose firing time the surrounding code does NOT control. */
export function fireAndForgetTimers(source) {
  const hits = [];
  const re = /(await\s+|return\s+)?(?:window\.)?(setTimeout|setInterval)\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) continue; // awaited or returned -> deterministic
    // A timer inside a `new Promise(...)` executor is deterministic: whoever
    // awaits (or races) that promise decides when execution resumes. Matched
    // by looking back for `new Promise` with no statement terminator between,
    // rather than by balancing parentheses: an executor's own parameter list
    // contains `)`, which defeated the naive lookbehind.
    const before = source.slice(Math.max(0, m.index - 200), m.index);
    const promiseAt = before.lastIndexOf("new Promise");
    if (promiseAt !== -1 && !before.slice(promiseAt).includes(";")) continue;
    hits.push(source.slice(0, m.index).split("\n").length);
  }
  return hits;
}

/**
 * The production files a test file covers, and how the pairing was found.
 *
 * `dir/__tests__/x.test.ts` covers `dir/x.ts`. A multi-dot name is matched
 * longest-first, so `a.browser.test.ts` covers `a.browser.ts` when that file
 * exists and `a.ts` only when it does not.
 */
export function subjectsOf(testFile, prodFiles) {
  const testDir = path.posix.dirname(testFile);
  const inTestsDir = path.posix.basename(testDir) === "__tests__";
  const prodDir = inTestsDir ? path.posix.dirname(testDir) : testDir;
  const stem = path.posix.basename(testFile).replace(TEST_FILE, "");
  const isDotTest = /\.test\.tsx?$/.test(testFile);

  const segments = stem.split(".");
  for (let keep = segments.length; keep >= 1; keep--) {
    const candidate = segments.slice(0, keep).join(".");
    const subjects = [`${prodDir}/${candidate}.ts`, `${prodDir}/${candidate}.tsx`].filter((p) => prodFiles.has(p));
    if (subjects.length > 0) {
      const direct = !inTestsDir && keep === segments.length && isDotTest;
      return { subjects, via: direct ? "race-sibling" : "race-widened" };
    }
  }
  return { subjects: [], via: null };
}

function walk(root, rel, out) {
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(child);
  }
  return out;
}

/** Scan a repository root. Returns findings per rule plus what was examined. */
export function scan(root) {
  const read = (rel) => readFileSync(path.join(root, rel), "utf8");
  const all = TEST_ROOTS.filter((r) => existsSync(path.join(root, r))).flatMap((r) => walk(root, r, []));
  const testFiles = all.filter((f) => TEST_FILE.test(f)).sort();
  const prodFiles = new Set(
    all.filter((f) => f.startsWith(`${PROD_ROOT}/`) && !TEST_FILE.test(f) && !f.includes("/__tests__/")),
  );

  const findings = Object.fromEntries(RULES.map((r) => [r, []]));
  const unreadable = [];
  const timersOf = new Map();
  const importedSleepHelper = importedSleepHelpers(root);
  let unpaired = 0;

  for (const testFile of testFiles) {
    const source = read(testFile);
    let usage;
    try {
      usage = scanTestClockUsage(source, testFile, { importedSleepHelper: importedSleepHelper(testFile) });
    } catch (error) {
      // Fail closed: a file this gate cannot parse is not a file it cleared.
      unreadable.push(`${testFile} (does not parse: ${error.message})`);
      continue;
    }
    const realTimersIntended = REAL_TIMERS_MARKER.test(source);

    if (!usage.controlsClock && !WALL_CLOCK_MARKER.test(source)) {
      for (const read of usage.wallClockReads) {
        findings["wall-clock-read"].push({ file: testFile, text: `${testFile}:${read.line}  ${read.what}` });
      }
    }
    if (!realTimersIntended) {
      // Under fake timers a delayed promise the test hands on (a mock's slow
      // result) is advanced like any timer; only a sleep the test awaits
      // where it is written waits on a clock nothing moves.
      const sleeping = usage.fakesTimers
        ? usage.sleeps.filter((s) => s.awaited)
        : usage.sleeps.filter((s) => s.ms >= SLEEP_THRESHOLD_MS);
      const rule = usage.fakesTimers ? "fake-timer-sleep" : "real-sleep";
      for (const sleep of sleeping) {
        findings[rule].push({ file: testFile, text: `${testFile}:${sleep.line}  ${sleep.ms}ms` });
      }
    }

    if (!testFile.startsWith(`${PROD_ROOT}/`)) continue;
    const { subjects, via } = subjectsOf(testFile, prodFiles);
    if (subjects.length === 0) {
      unpaired += 1;
      continue;
    }
    if (usage.controlsClock || realTimersIntended) continue;
    // A synchronous test body cannot be interleaved by a timer.
    if (!/\bawait\b/.test(source) && !/async\s*\(/.test(source)) continue;
    for (const subject of subjects) {
      if (!timersOf.has(subject)) timersOf.set(subject, fireAndForgetTimers(read(subject)));
      const lines = timersOf.get(subject);
      if (lines.length === 0) continue;
      findings[via].push({
        file: testFile,
        text: `${testFile} races ${subject} (fire-and-forget timer at line ${lines.join(", ")})`,
      });
    }
  }

  return { findings, unreadable, prodCount: prodFiles.size, testCount: testFiles.length, unpaired };
}

function usage(message) {
  console.error(`❌ ${message}`);
  console.error("Usage: node scripts/check-test-timer-isolation.mjs [--root <dir>] [--report-only <rules|none>]");
  process.exit(64);
}

function main() {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let reportOnly = REPORT_ONLY_RULES;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = path.resolve(argv[++i]);
    else if (argv[i] === "--report-only" && argv[i + 1]) {
      const value = argv[++i];
      reportOnly = value === "none" ? [] : value.split(",").map((s) => s.trim());
    } else usage(`unknown argument: ${argv[i]}`);
  }
  for (const rule of reportOnly) if (!RULES.includes(rule)) usage(`unknown rule: ${rule}`);

  if (!existsSync(path.join(root, PROD_ROOT))) {
    console.error(`❌ ${PROD_ROOT}/ not found under ${root} — the timer-isolation gate has nothing to scan.`);
    process.exit(1);
  }
  const { findings, unreadable, prodCount, testCount, unpaired } = scan(root);
  console.log(
    `Test-timer isolation: ${prodCount} production files, ${testCount} test files (${unpaired} unpaired with any subject).`,
  );
  if (prodCount === 0 || testCount === 0) {
    console.error("❌ Nothing to compare — refusing to pass on an empty scan.");
    process.exit(1);
  }

  const print = (rule) => {
    const list = findings[rule];
    const files = new Set(list.map((f) => f.file)).size;
    console.log(`  ${rule}: ${list.length}${list.length > 0 ? ` in ${files} file(s)` : ""}`);
    for (const f of list) console.log(`    ${f.text}`);
  };
  const enforced = RULES.filter((r) => !reportOnly.includes(r));
  console.log("ENFORCED");
  enforced.forEach(print);
  if (reportOnly.length > 0) {
    console.log("REPORT-ONLY (printed every run, not failing yet)");
    RULES.filter((r) => reportOnly.includes(r)).forEach(print);
  }

  const count = (rules) => rules.reduce((n, r) => n + findings[r].length, 0);
  const problems = [];
  for (const file of unreadable) problems.push(`${file}`);
  if (count(enforced) > 0) {
    problems.push(
      `${count(enforced)} finding(s) in enforced rules. Control the clock (vi.useFakeTimers() in beforeEach,\n` +
        "   vi.useRealTimers() in afterEach), or opt out with a reason:\n" +
        "   // timer-isolation: intentional real timers — <reason>\n" +
        "   // timer-isolation: intentional wall clock — <reason>",
    );
  }
  for (const rule of reportOnly) {
    if (findings[rule].length === 0) {
      problems.push(
        `${rule} is report-only but has no findings left — remove it from REPORT_ONLY_RULES in\n` +
          "   scripts/check-test-timer-isolation.mjs so it is enforced from here on.",
      );
    }
  }
  if (count(reportOnly) > 0) {
    console.log(`\n⚠ ${count(reportOnly)} finding(s) in report-only rules are NOT failing this run.`);
  }
  if (problems.length > 0) {
    console.error(`\n❌ ${problems.join("\n❌ ")}`);
    process.exit(1);
  }
  console.log("✅ Test-timer isolation held for every enforced rule.");
}

if (isMainModule(import.meta.url)) main();
