#!/usr/bin/env node
/**
 * Production-reachability gate — a module that only its tests import
 * is dead in production, and knip's default mode cannot see it.
 *
 * Why: `pnpm knip` treats every test file as an ENTRY (knip.json), so a module
 * reachable only from a test counts as used. The feature ledger found
 * 14 such modules by hand (finding F1). A direct-importer rule ("does any
 * non-test file import it?") was rejected in review: it is fooled by dead→dead
 * chains — GhaWorkflowPanel imports WorkflowPanelShell, and nothing imports
 * GhaWorkflowPanel — and by import cycles.
 *
 * What it does: runs knip in PRODUCTION mode against scripts/knip-production.json,
 * whose entry and project patterns carry knip's `!` production marker. Roots are
 * src/main.tsx, eslint.config.js, scripts/*.{ts,mjs}, .claude/hooks/*.mjs and
 * the two server packages' cli/index, so the result is reachability from real
 * roots (eslint.config.js loads the local lint rules under scripts/lib; knip's
 * eslint plugin is switched off there so the file is followed as a plain
 * entry rather than claimed as a dev-only plugin config), following
 * static imports, dynamic import(), re-exports and the `@/` alias (knip resolves
 * tsconfig paths). Every file knip reports as unused is unreachable from every
 * root. Test-support modules (src/test/, __tests__/, *.testUtils.ts, src/bench/,
 * a `testX.ts` helper) are legitimately test-only; isTestSupport() names the
 * convention and they are not findings.
 *
 * Measured on adoption: 71 unreachable files, 41 of them test support, so 30
 * findings (the ledger had found 14 by hand) — frozen in scripts/test-only-modules-baseline.json as an IDENTITY
 * list. Two-way, the house standard: an unlisted finding fails, and so does a
 * listed module that is no longer a finding (record the win by deleting the
 * entry, or `--update`). Phase 3 of the plan drives the list to zero.
 *
 * Fails closed: knip missing or crashing (anything but its "issues found" exit
 * 1), a non-JSON reply or one whose shape is not the reporter's, an exit status
 * that DISAGREES with the report (exit 1 with no unused file listed, or exit 0
 * with one), a malformed baseline, a baseline that cannot be written, or a
 * production ENTRY that no longer exists on disk — a literal file, or a glob
 * that matches nothing — each exit 2 with a loud message. The entry check
 * matters: renaming src/main.tsx would otherwise empty the graph and report
 * every module as a finding — visible while the baseline is non-empty (every
 * entry turns stale) and invisible once it reaches zero, so the roots are
 * asserted directly.
 *
 * `--update` re-measures, and REFUSES to grow an existing baseline — including
 * one that has reached zero; only a baseline that does not exist yet is
 * written unconditionally: entries only leave (wire the module, delete it, or
 * move it under a test-support path). `--allow-growth` overrides that for a
 * declared re-measurement — one the ratchet manifest (`onAdd: "fail"`) must
 * also be told about.
 *
 * Exit codes: 0 clean, 1 findings or stale entries, 2 gate failure, 64 usage.
 * Self-tested by scripts/check-test-only-modules.test.mjs.
 *
 * @coordinates-with scripts/knip-production.json — the production graph definition
 * @coordinates-with scripts/test-only-modules-baseline.json — the identity baseline
 * @coordinates-with scripts/baselineRatchetManifest.mjs — registers the baseline
 * @coordinates-with knip.json — the default-mode config this gate does NOT use
 * @coordinates-with scripts/lib/testOnlyModulesGraph.mjs — knip's production graph and its report
 * @coordinates-with scripts/lib/testOnlyModulesBaseline.mjs — the baseline's ratchet rules
 */
import { isMainModule } from "./lib/isMainModule.mjs";
import { ROOT, assertGraphDefinition, readConfig, runKnip } from "./lib/testOnlyModulesGraph.mjs";
import {
  BASELINE_PATH,
  compareWithBaseline,
  readBaseline,
  updateDecision,
  writeBaseline,
} from "./lib/testOnlyModulesBaseline.mjs";

export {
  ROOT,
  CONFIG_PATH,
  parseKnipFiles,
  productionEntries,
  globToRegExp,
  globMatches,
  unmarkedPatterns,
  readConfig,
  assertGraphDefinition,
  runKnip,
} from "./lib/testOnlyModulesGraph.mjs";
export {
  BASELINE_PATH,
  readBaseline,
  writeBaseline,
  compareWithBaseline,
  updateDecision,
} from "./lib/testOnlyModulesBaseline.mjs";

const USAGE = "usage: node scripts/check-test-only-modules.mjs [--update [--allow-growth]] [--report]";

/**
 * Modules that legitimately live only in the test graph. A path matching one of
 * these is test support, not a finding. The convention is deliberately narrow:
 * a production-looking module under a production directory that only tests
 * import is exactly the defect this gate exists to report.
 */
/**
 * Test-support modules a directory or suffix convention does not reach, named
 * one by one. This was a `test[A-Z]\w*` FILENAME pattern, which is a claim
 * about every future file too: `testConnection.ts`, `testHarness.ts`,
 * `testRenderer.ts` are ordinary production names, and one of them going dead
 * would have been excluded from the measurement rather than reported.
 * Measured across `src/`, `scripts/`, `server/` and
 * `e2e/`: the pattern matched exactly three files, two of them already covered
 * by the `__tests__/` rule, so the whole heuristic was carrying ONE entry.
 * The self-test asserts every entry still exists in THIS repository (it cannot
 * live in the gate itself, which also runs against fixture trees), so the list
 * cannot rot into an exclusion of nothing.
 */
export const TEST_SUPPORT_FILES = new Set(["src/utils/markdownPipeline/testSchema.ts"]);

export function isTestSupport(path) {
  const p = path.replace(/\\/g, "/");
  return (
    /(^|\/)(__tests__|__mocks__|__acceptance__)\//.test(p) ||
    /^src\/(test|bench)\//.test(p) ||
    /^scripts\/__tests__\//.test(p) ||
    /^e2e\//.test(p) ||
    /\.(test|spec|testUtils|bench)\.[cm]?[jt]sx?$/.test(p) ||
    TEST_SUPPORT_FILES.has(p)
  );
}

/** The measured findings on the live tree: unreachable, and not test support. */
export function measure(root = ROOT) {
  const config = readConfig(root);
  assertGraphDefinition(config, root);
  const all = runKnip(root);
  return { all, findings: all.filter((p) => !isTestSupport(p)) };
}

function main(argv) {
  const flags = new Set(argv);
  for (const a of argv) if (!["--update", "--report", "--allow-growth"].includes(a)) { console.error(USAGE); return 64; }
  if (flags.has("--allow-growth") && !flags.has("--update")) { console.error(USAGE); return 64; }
  let measured;
  let existing;
  try {
    measured = measure();
    existing = readBaseline();
  } catch (err) {
    console.error(`✗ check-test-only-modules: ${err.message}`);
    return 2;
  }
  const { all, findings } = measured;
  const baseline = existing ?? [];
  if (flags.has("--update")) {
    const { added, removed, refused } = updateDecision(findings, existing, { allowGrowth: flags.has("--allow-growth") });
    if (refused) {
      for (const p of added) console.log(`✗ would ADD to the baseline: ${p}`);
      console.log(`\n--update refused: entries only leave this baseline. Wire, delete or move the module; --allow-growth records a declared re-measurement (the ratchet manifest refuses growth in CI regardless).`);
      return 1;
    }
    try {
      writeBaseline(findings);
    } catch (err) {
      console.error(`✗ check-test-only-modules: cannot write ${BASELINE_PATH}: ${err.message}`);
      return 2;
    }
    console.log(`✓ wrote ${findings.length} entries to ${BASELINE_PATH} (+${added.length} / -${removed.length}; ${all.length - findings.length} test-support modules excluded)`);
    return 0;
  }
  const { unlisted, stale } = compareWithBaseline(findings, baseline);
  if (flags.has("--report")) {
    console.log(`production-unreachable modules: ${all.length} (${all.length - findings.length} test support, ${findings.length} findings)`);
    for (const p of findings) console.log(`  ${p}`);
  }
  for (const p of unlisted) console.log(`✗ unreachable from every production root and not in the baseline: ${p}`);
  for (const p of stale) console.log(`✗ baseline entry is no longer a finding (delete it, or --update): ${p}`);
  if (unlisted.length || stale.length) {
    console.log(`\n${unlisted.length} new, ${stale.length} stale. A new finding is a module only tests reach: wire it from a production root, delete it, or move it under a test-support path.`);
    return 1;
  }
  console.log(`✓ check-test-only-modules: ${findings.length} baselined, 0 new, 0 stale (${all.length} unreachable incl. test support)`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
