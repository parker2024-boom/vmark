#!/usr/bin/env node
/**
 * Generates `dev-docs/feature-metrics.md` — the per-feature evidence table.
 *
 * The spine (`scripts/feature-map.json`) names features and the paths they
 * occupy. EVERY other column here is JOINED from something this repo already
 * measures. Nothing in the output is typed by hand, and nothing is estimated.
 *
 * This file is the QUANTITATIVE half of the feature ledger. The qualitative
 * half — what each feature does, how it is reached and gated, what documents
 * and tests it, what is known to be unwired or stale — is the hand-inspected
 * `.claude/feature-ledger.md`, which cites these cells rather than restating
 * them. Keep the two apart: a generated file that anyone hand-edits is
 * overwritten on the next run, and a hand-written file that restates numbers
 * goes stale on the next commit.
 *
 * Sources joined:
 *   - tokei                                  -> code / comment lines (code only)
 *   - find + wc                              -> test files and test lines
 *   - coverage/coverage-summary.json         -> per-file line coverage (if present)
 *   - scripts/file-size-baseline.json        -> oversized-file debt
 *   - scripts/mock-boundaries-baseline.json  -> internal-module mocking
 *   - .dependency-cruiser-known-violations.json -> layering debt
 *   - scripts/plugin-store-coupling-baseline.json -> plugin->host coupling
 *   - git log --name-status (whole history)  -> commits in window, last touch,
 *                                               ledger freshness — through deletions
 *                                               and renames (scripts/lib/featureHistory.mjs)
 *   - src/stores/settingsStore/defaults.ts   -> VERIFIES each spine flagDefault
 *
 * THERE IS NO ISSUE-COUNT COLUMN, AND ADDING ONE WOULD BE A MISTAKE. It is the
 * obvious next column — "how much user pain has this feature caused?" — and it
 * was tried while this ledger was being built. Two things went wrong, and the
 * second is the one worth remembering.
 *
 * The mechanical error: closed issues were classified by keyword-matching their
 * TITLES, over the most recent 400 of the repository's 789, and the result was
 * then described as the whole history. A partial sample matched by a crude
 * regex is not a census, and the browser's two apparent hits turned out to be
 * accessibility audits of `LinkPopupView` that contained the word incidentally.
 *
 * The reasoning error, which no better query would fix: most of the features
 * worth asking about here are default-OFF. A feature nobody can reach without
 * flipping a flag produces no issue traffic BY CONSTRUCTION, so a low count
 * restates the gate column and reads as evidence about the feature. That is how
 * "the embedded browser has almost no issues" got offered as independent
 * corroboration that it is unused, when it is a near-tautology.
 *
 * If someone still wants demand data, it has to come from something that can
 * distinguish "nobody hit a bug" from "nobody could reach the code" — telemetry
 * on the flag, or issues filed by users who had it enabled. Until such a source
 * exists, the honest ledger is silent here rather than confidently wrong.
 *
 * THE HONESTY RULE, and it is the whole point of this script: a signal that was
 * not measured for a feature prints `--`, never `0`. Those are different claims.
 * `0` says "measured, and clean"; `--` says "nobody looked". Coverage is the one
 * that matters most — `coverage/` is gitignored, so on a fresh clone every
 * coverage cell is `--` until `pnpm test:coverage` runs. Printing `0%` there
 * would invent a catastrophe; printing `100%` would invent a guarantee.
 *
 * FAILS CLOSED on a stale spine: a `paths` entry matching nothing on disk, a
 * `doc` naming a page that does not exist, or a `flagDefault` that disagrees
 * with the shipped default in `defaults.ts`, is an error — not a warning. A
 * ledger that silently drops a renamed feature reports the same green as one
 * that works, which is the failure mode `check-scripts-parity` and
 * `shell-slots` already exist to prevent. The flag check exists because the
 * spine carried `browser.enabled = false` for three weeks after the shipped
 * default flipped to `true`, and the Gate column printed the wrong value with
 * full confidence — the cell was prose in JSON, and nothing measured it.
 *
 * FAILS CLOSED on its own measurements too: a `find` or `git` that fails throws
 * (an empty result used to become an authoritative 0 / `--`), a path that holds
 * no file at all is a stale-spine error, and so is a path that holds no CODE
 * file unless the spine DECLARES it data-only (`dataOnly: ["src-tauri/locales"]`
 * — legitimate: it has no code, `0` is the honest count, and the declaration
 * is what separates "measured, data" from "the code moved and nobody looked";
 * a declared data path that does hold code is the stale declaration), a baseline
 * whose container or records are not the shape the join reads is an error
 * while an EMPTY container is the ratchet reaching zero, and coverage is
 * printed only when the summary holds EVERY coverage-eligible file of the
 * feature — otherwise `--` with `n/m files`, because the summary lists just
 * the files some test loaded and averaging those reports the tested fraction
 * as the feature's coverage.
 *
 * FAILS CLOSED on the inputs the feature-map gate judges, by the gate's own
 * rules: ambiguous or fully shadowed claims (`claimErrors`) and a ledger the
 * gate refuses (`ledgerErrors`) stop generation, so this never renders counts
 * or freshness from a spine or ledger `pnpm lint:feature-map` would reject.
 *
 * Regenerate: `node scripts/gen-feature-ledger.mjs [--since=<git date>]`. Do
 * not hand-edit the output. Rendering lives in scripts/lib/featureLedgerRender.mjs;
 * spine validation in featureSpine.mjs, the defaults.ts reader in
 * settingsDefaultsSource.mjs, measurement in featureMeasure.mjs, the joined
 * baselines and coverage in featureLedgerSources.mjs, and row assembly in
 * featureLedgerRows.mjs (all under scripts/lib/).
 * Self-test: `scripts/gen-feature-ledger.test.mjs` (gates tier).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { renderLedger } from "./lib/featureLedgerRender.mjs";
import { CODE_EXTENSIONS, claimErrors, isCodeFile } from "./lib/featureOwnership.mjs";
import { LEDGER_REL, ledgerErrors, parseLedger } from "./lib/featureLedgerDoc.mjs";
import { gitIn, ledgerProbes, repoFiles } from "./lib/featureMapInputs.mjs";
import { DEFAULTS_REL, parseSettingsDefaults, verifyFlagDefaults } from "./lib/settingsDefaultsSource.mjs";
import { countLines, featureInventory, listFiles, normalizePaths, run, tokeiCode } from "./lib/featureMeasure.mjs";
import { spineErrors, spineShapeErrors } from "./lib/featureSpine.mjs";
import { coverageEligible, featureCoverage, joinSources } from "./lib/featureLedgerSources.mjs";
import { coverageForTree, ledgerBlocksByFeature, measureFeature, ownedInventory, readHistory } from "./lib/featureLedgerRows.mjs";
import { isMainModule } from "./lib/isMainModule.mjs";

/**
 * The ledger's helpers, re-exported: this file stays the one entry its
 * self-test and the feature-map gate import, while each concern lives in its
 * own module. The extension list and the code-file test are the OWNERSHIP
 * module's, not a copy — inventory and ownership describe one population.
 */
export {
  CODE_EXTENSIONS,
  isCodeFile,
  run,
  parseSettingsDefaults,
  verifyFlagDefaults,
  spineShapeErrors,
  spineErrors,
  normalizePaths,
  tokeiCode,
  listFiles,
  featureInventory,
  countLines,
  joinSources,
  coverageEligible,
  featureCoverage,
};

const OUTPUT_REL = "dev-docs/feature-metrics.md";
const WINDOW_DAYS = 180;
const USAGE = "usage: node scripts/gen-feature-ledger.mjs [--since=<git date expression>]";

/**
 * Parse a JSON source, or `null` when the file is ABSENT.
 *
 * Three outcomes used to collapse into two: a file holding the literal `null`
 * read as "absent" (so a `null` feature-map reported "missing" and a `null`
 * coverage summary printed `--`), and a malformed one threw a bare
 * `SyntaxError` that named no path — the stack trace pointed at this line, not
 * at the file the reader has to fix.
 */
function readJson(p, label = p) {
  if (!existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    throw new Error(`${label}: not valid JSON — ${error.message}`);
  }
  if (parsed === null) throw new Error(`${label}: holds the literal null, which is not a document this joins`);
  return parsed;
}

/** Strict argv: only `--since=<git date>`, non-empty and table-safe; anything else is a usage error. */
export function parseArgs(argv) {
  let since = `${WINDOW_DAYS} days ago`;
  for (const a of argv) {
    const m = /^--since=([\s\S]*)$/.exec(a);
    if (!m) throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    const value = m[1].trim();
    if (value === "" || /[\n\r`|]/.test(value)) {
      throw new Error(`--since needs a git date expression with no newline, backtick or pipe (got ${JSON.stringify(m[1])})\n${USAGE}`);
    }
    since = value;
  }
  return { since };
}

// ---------------------------------------------------------------- main
function refuse(code, headline, lines, footer) {
  console.error(`${headline}\n`);
  for (const l of lines) console.error("  " + l);
  if (footer) console.error(`\n${footer}`);
  process.exit(code);
}

/** Stale-spine errors, then — on a spine of valid shape — ambiguous or fully shadowed claims over every code file in the tree. */
function spineAndClaimErrors(root, spine, defaultsSource, files) {
  const errors = spineErrors(root, spine, defaultsSource);
  if (spineShapeErrors(spine).length) return errors;
  return [...errors, ...claimErrors(spine, files.filter(isCodeFile))];
}

/** A step that fails exits with `code` and the reason, never a stack trace. */
function attempt(code, headline, step) {
  try {
    return step();
  } catch (err) {
    refuse(code, headline, [err instanceof Error ? (err.stderr ? String(err.stderr).trim() : err.message) : String(err)]);
    return null; // unreachable — refuse() exits
  }
}

function main() {
  const ROOT = process.cwd();
  const args = attempt(64, "Bad invocation:", () => parseArgs(process.argv.slice(2)));
  // A source that cannot be PARSED is named and refused, not thrown as a bare
  // SyntaxError whose stack points at readJson rather than at the file.
  const read = (rel) => attempt(66, "A source this ledger joins is not readable:", () => readJson(path.join(ROOT, rel), rel));
  const spine = read("scripts/feature-map.json");
  if (!spine) refuse(64, "scripts/feature-map.json missing", []);
  const git = gitIn(ROOT);
  const files = attempt(66, "git cannot list this tree:", () => repoFiles(ROOT, git));

  const defaultsPath = path.join(ROOT, DEFAULTS_REL);
  const errors = spineAndClaimErrors(ROOT, spine, existsSync(defaultsPath) ? readFileSync(defaultsPath, "utf8") : null, files);
  if (errors.length) {
    refuse(65, "feature-map.json is stale — the ledger refuses to generate:", errors,
      `${errors.length} stale entr${errors.length === 1 ? "y" : "ies"}. Fix the map, do not delete the row.`);
  }
  const sources = joinSources({
    fileSize: read("scripts/file-size-baseline.json"),
    mockB: read("scripts/mock-boundaries-baseline.json"),
    depX: read(".dependency-cruiser-known-violations.json"),
    coupling: read("scripts/plugin-store-coupling-baseline.json"),
  });
  if (sources.problems.length) {
    refuse(66, "A baseline is not the shape this join reads — its column would be all zeros, which reads as 'clean':", sources.problems,
      "Fix the parse. An all-zero column is a false all-clear.");
  }
  const { inventory, owner } = ownedInventory(spine);
  // The qualitative ledger, when this machine has it — VALIDATED by the gate's
  // own rules first: a ledger the gate refuses would render counts and
  // freshness that read as authoritative.
  const ledgerPath = path.join(ROOT, LEDGER_REL);
  const ledger = existsSync(ledgerPath) ? parseLedger(readFileSync(ledgerPath, "utf8")) : null;
  const ledgerProblems = ledger ? ledgerErrors(ledger, spine, ledgerProbes(ROOT, git, files)) : [];
  if (ledgerProblems.length) refuse(65, `${LEDGER_REL} does not pass the feature-map gate — the ledger refuses to render it:`, ledgerProblems);

  const { covSummary, covStale } = coverageForTree(ROOT, inventory, read("coverage/coverage-summary.json"));
  const rows = attempt(67, "A measurement failed — the ledger refuses to print a number it did not measure:", () => {
    const history = readHistory(spine, args.since, git);
    const ctx = { root: ROOT, since: args.since, covSummary, inventory, owner, ledgerBlocks: ledgerBlocksByFeature(ledger), history, ...sources };
    return spine.features.map((f) => measureFeature(f, ctx));
  });
  rows.sort((a, b) => (b.code || 0) - (a.code || 0));

  const covPresent = covSummary !== null;
  mkdirSync(path.join(ROOT, "dev-docs"), { recursive: true });
  // Written through a sibling temporary file and RENAMED into place: a direct
  // write truncates first, so an interruption leaves a half-written ledger that
  // still looks like the document. A rename within one
  // directory is atomic, so a reader sees the old file or the new one.
  const outPath = path.join(ROOT, OUTPUT_REL);
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, renderLedger(rows, { since: args.since, defaultsRel: DEFAULTS_REL, covPresent, ledger }));
  renameSync(tmpPath, outPath);
  console.log(`wrote ${OUTPUT_REL} — ${rows.length} features`);
  if (!covPresent) {
    console.log(
      covStale
        ? "NOTE: coverage/coverage-summary.json is OLDER than a measured source file, so it did not measure this tree; coverage columns are '--'. Re-run `pnpm test:coverage`."
        : "NOTE: coverage/coverage-summary.json absent; coverage columns are '--'",
    );
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
