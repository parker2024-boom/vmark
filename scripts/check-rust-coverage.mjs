#!/usr/bin/env node
/**
 * Rust line-coverage floor, read from a ratcheted baseline and compared both
 * ways.
 *
 * Purpose: turn one llvm-cov summary into a verdict against
 * `scripts/rust-coverage-baseline.json`.
 *
 * Why it exists: the floor used to be a number typed into the workflow
 * (`--fail-under-lines`), outside every ratchet, and it was only ever checked
 * in one direction. Nothing asked for it to be raised as tests were added, so
 * it ended up tens of points under the real figure, and a floor that far down
 * passes any regression smaller than the gap. A floor that is never raised
 * stops being a floor.
 *
 * The baseline stores the ceiling on UNCOVERED lines rather than the floor on
 * covered ones, because the baseline ratchet's scalar check refuses a number
 * that goes up: expressed this way, loosening the gate is a raise and
 * tightening it is a drop, like every other baseline.
 *
 * Rules:
 *   - uncovered above `maxUncoveredLinePercent` fails: coverage fell;
 *   - uncovered more than `maxSlackPercent` below it fails too: the floor is
 *     stale, and the message gives the ceiling to commit;
 *   - the percentage is computed from the line counts, not read from the
 *     summary's own `percent`.
 *
 * Fails closed (exit 64) on a summary or baseline it cannot read, and on a
 * summary that measured zero lines: a run that instrumented nothing looks,
 * to a percentage, like a run with nothing to cover.
 *
 * Usage:
 *   cargo llvm-cov report --json --summary-only --output-path summary.json
 *   node scripts/check-rust-coverage.mjs summary.json
 *
 * Exit codes: 0 inside the band · 1 below the floor or floor stale · 64 unreadable
 *
 * @coordinates-with scripts/rust-coverage-baseline.json — the floor
 * @coordinates-with .github/workflows/rust-coverage.yml — the weekly measurement
 * @coordinates-with scripts/baselineRatchetManifest.mjs — refuses a raised ceiling
 * @coordinates-with scripts/check-rust-coverage.test.mjs
 * @module scripts/check-rust-coverage
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/isMainModule.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(REPO, "scripts/rust-coverage-baseline.json");

/** Thrown for input that cannot be turned into a verdict. */
export class UnreadableError extends Error {}

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new UnreadableError(`${label} is not JSON`);
  }
}

/** `{ count, covered }` for lines, from an llvm-cov JSON summary. */
export function lineTotals(summaryText) {
  const parsed = parseJson(summaryText, "the coverage summary");
  const lines = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data[0]?.totals?.lines : undefined;
  if (!isRecord(lines)) throw new UnreadableError("the coverage summary has no `data[0].totals.lines`");
  const { count, covered } = lines;
  if (!Number.isInteger(count) || !Number.isInteger(covered) || covered < 0 || covered > count) {
    throw new UnreadableError("the coverage summary's line counts are not a valid count/covered pair");
  }
  if (count === 0) throw new UnreadableError("the coverage summary measured zero lines");
  return { count, covered };
}

/** The two baseline numbers, validated. */
export function readBaseline(baselineText) {
  const parsed = parseJson(baselineText, "scripts/rust-coverage-baseline.json");
  const ceiling = isRecord(parsed) ? parsed.maxUncoveredLinePercent : undefined;
  const slack = isRecord(parsed) ? parsed.maxSlackPercent : undefined;
  if (typeof ceiling !== "number" || !(ceiling >= 0 && ceiling <= 100)) {
    throw new UnreadableError("`maxUncoveredLinePercent` must be a number from 0 to 100");
  }
  if (typeof slack !== "number" || !(slack > 0 && slack <= 100)) {
    throw new UnreadableError("`maxSlackPercent` must be a number above 0");
  }
  return { ceiling, slack };
}

/**
 * Compare a measurement with the baseline.
 *
 * Returns `{ coveredPercent, floorPercent, problem }` where `problem` is
 * `null`, `"below-floor"` or `"stale-floor"`, plus `suggestedCeiling` for the
 * stale case: the measured uncovered share with half the slack kept as
 * headroom, so the next run does not sit on the edge of the band.
 */
export function evaluate({ count, covered }, { ceiling, slack }) {
  const coveredPercent = (covered / count) * 100;
  const uncovered = 100 - coveredPercent;
  const floorPercent = 100 - ceiling;
  // Compared in hundredths: the edges of the band are part of it, and a
  // floating-point remainder must not push an exact match outside.
  const hundredths = (value) => Math.round(value * 100);
  let problem = null;
  if (hundredths(uncovered) > hundredths(ceiling)) problem = "below-floor";
  else if (hundredths(ceiling - uncovered) > hundredths(slack)) problem = "stale-floor";
  const suggestedCeiling = Math.round((uncovered + slack / 2) * 100) / 100;
  return { coveredPercent, floorPercent, problem, suggestedCeiling };
}

function main() {
  const summaryPath = process.argv[2];
  let totals;
  let baseline;
  try {
    if (!summaryPath) throw new UnreadableError("usage: check-rust-coverage.mjs <llvm-cov-summary.json>");
    let summaryText;
    try {
      summaryText = readFileSync(summaryPath, "utf8");
    } catch (error) {
      throw new UnreadableError(`cannot read ${summaryPath}: ${error.message}`);
    }
    totals = lineTotals(summaryText);
    baseline = readBaseline(readFileSync(BASELINE, "utf8"));
  } catch (error) {
    if (!(error instanceof UnreadableError)) throw error;
    console.error(`rust-coverage: ${error.message}`);
    process.exit(64);
  }

  const { coveredPercent, floorPercent, problem, suggestedCeiling } = evaluate(totals, baseline);
  const measured = `${coveredPercent.toFixed(2)}% of ${totals.count} lines covered`;
  const floor = `floor ${floorPercent.toFixed(2)}%`;

  if (problem === "below-floor") {
    console.error(`rust-coverage: ${measured} — below the floor of ${floorPercent.toFixed(2)}%.`);
    console.error("Add tests for what the change left uncovered; the ceiling in");
    console.error("scripts/rust-coverage-baseline.json is not raised to make this pass.");
    process.exit(1);
  }
  if (problem === "stale-floor") {
    console.error(`rust-coverage: ${measured}, ${floor} — the floor is stale.`);
    console.error(`Coverage is more than ${baseline.slack} points above it. Lower the ceiling in`);
    console.error("scripts/rust-coverage-baseline.json and record the measurement:");
    console.error(`  "maxUncoveredLinePercent": ${suggestedCeiling}`);
    console.error(`  "measured.linePercent": ${Math.floor(coveredPercent * 100) / 100}`);
    process.exit(1);
  }
  console.log(`rust-coverage: ${measured} (${floor}, ceiling ${baseline.ceiling}% uncovered)`);
}

if (isMainModule(import.meta.url)) main();
