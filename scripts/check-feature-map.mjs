#!/usr/bin/env node
/**
 * Feature-map gate — the feature ledger cannot silently fall behind the code.
 *
 * Three checks, strongest first:
 *   1. SPINE: `scripts/feature-map.json` is valid — every path exists and holds
 *      code (or is declared data), every doc page exists, every flag default
 *      matches `defaults.ts`. This is the generator's own validation
 *      (`spineErrors`), which used to run only when someone regenerated the
 *      metrics by hand, so the spine could be stale for weeks.
 *   2. OWNERSHIP: every production source file (`src/`, `src-tauri/src/`,
 *      `server/<pkg>/src/`, tests excluded) has exactly one owner — a feature or
 *      the declared infrastructure bucket — resolved by most specific claim. A
 *      new module that joins no feature fails here, at PR time. Zero-tolerance,
 *      no baseline: on adoption every file was assigned.
 *   3. LEDGER (`.claude/feature-ledger.md`, tracked, REQUIRED): every block
 *      names a spine feature, every spine feature has a block, every path a
 *      block cites in `code`/`rust`/`docs`/`tests` exists (a glob matches a
 *      file), and every area records the commit it was verified against — one
 *      that is an ancestor of HEAD. It used to live in the gitignored `dev-docs/`,
 *      where CI could not see it; a missing ledger now fails. The first ledger
 *      went from accurate to nineteen releases stale there, with no signal.
 *
 * A spine of the wrong SHAPE is reported alone: every later check would be
 * reasoning about a guess, and `null` used to crash the ownership pass with a
 * TypeError instead of producing a finding.
 *
 * Usage: node scripts/check-feature-map.mjs [--root=<dir>]
 *   exit 0 clean, 1 findings, 64 bad invocation, 66 unreadable input — the
 *   spine, the git file list, defaults.ts, the ledger, or a `find` the spine
 *   validation runs. Each is named; none is a stack trace.
 *
 * @coordinates-with scripts/lib/featureOwnership.mjs — ownership resolution
 * @coordinates-with scripts/lib/featureLedgerDoc.mjs — ledger parsing and joins
 * @coordinates-with scripts/gen-feature-ledger.mjs — the spine validation reused here
 * @coordinates-with scripts/lib/featureMapInputs.mjs — the file list and ledger probes
 * @coordinates-with scripts/check-feature-map.test.mjs — the self-test
 * @module scripts/check-feature-map
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spineErrors, spineShapeErrors } from "./gen-feature-ledger.mjs";
import { claimErrors, isCodeFile, ownershipUniverse, resolveOwners } from "./lib/featureOwnership.mjs";
import { LEDGER_REL, ledgerErrors, parseLedger } from "./lib/featureLedgerDoc.mjs";
import { gitIn, ledgerProbes, repoFiles } from "./lib/featureMapInputs.mjs";

const SPINE_REL = "scripts/feature-map.json";
const DEFAULTS_REL = "src/stores/settingsStore/defaults.ts";

function parseArgs(argv) {
  let root = process.cwd();
  for (const a of argv) {
    if (a.startsWith("--root=")) root = path.resolve(a.slice("--root=".length));
    else {
      console.error(`unknown argument: ${a}\nusage: node scripts/check-feature-map.mjs [--root=<dir>]`);
      process.exit(64);
    }
  }
  return { root };
}

/** Read one input, or exit 66 NAMING it: an unreadable input is not a finding about the tree. */
function input(what, read) {
  try {
    return read();
  } catch (err) {
    const why = err instanceof Error ? (err.stderr ? String(err.stderr).trim() : err.message) : String(err);
    console.error(`${what}: unreadable — ${why.split("\n")[0]}`);
    process.exit(66);
  }
}

function report(errors) {
  console.error(`Feature map: ${errors.length} finding${errors.length === 1 ? "" : "s"}\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const git = gitIn(root);
  const spine = input(SPINE_REL, () => JSON.parse(readFileSync(path.join(root, SPINE_REL), "utf8")));
  // Tracked plus untracked-not-ignored: a new file must fail before it is committed.
  const files = input("git ls-files", () => repoFiles(root, git));
  const shape = spineShapeErrors(spine);
  if (shape.length) report(shape);

  const defaultsPath = path.join(root, DEFAULTS_REL);
  const defaults = input(DEFAULTS_REL, () => (existsSync(defaultsPath) ? readFileSync(defaultsPath, "utf8") : null));
  const errors = [
    ...input("spine validation (find over the spine's paths)", () => spineErrors(root, spine, defaults)),
    ...claimErrors(spine, files.filter(isCodeFile)),
  ];
  const universe = ownershipUniverse(files);
  const { unowned } = resolveOwners(spine, universe);
  for (const f of unowned) errors.push(`${f} is owned by no feature — add it to a feature's paths in ${SPINE_REL}, or to infrastructure.paths`);

  const ledgerPath = path.join(root, LEDGER_REL);
  let ledgerNote = "";
  if (!existsSync(ledgerPath)) {
    errors.push(`${LEDGER_REL} is missing — the ledger is tracked and required`);
  } else {
    const doc = parseLedger(input(LEDGER_REL, () => readFileSync(ledgerPath, "utf8")));
    errors.push(...ledgerErrors(doc, spine, ledgerProbes(root, git, files)));
    ledgerNote = `ledger: ${doc.blocks.length} blocks in ${doc.areas.length} areas joined to ${spine.features.length} features`;
  }

  if (errors.length) report(errors);
  console.log(`✓ feature map: ${universe.length} production files, each with one owner`);
  console.log(`  ${ledgerNote}`);
}

main();
