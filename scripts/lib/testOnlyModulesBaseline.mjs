/**
 * The test-only-modules gate's identity baseline: read, write (atomically),
 * compare two ways, and decide what `--update` may record.
 *
 * Purpose: the baseline's ratchet rules — entries only leave, an existing
 * baseline never grows without `--allow-growth` — in one place, apart from the
 * knip measurement in `testOnlyModulesGraph.mjs`.
 *
 * @coordinates-with scripts/check-test-only-modules.mjs — the gate (CLI) that re-exports this
 * @coordinates-with scripts/test-only-modules-baseline.json — the identity baseline
 * @module scripts/lib/testOnlyModulesBaseline
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./testOnlyModulesGraph.mjs";

export const BASELINE_PATH = "scripts/test-only-modules-baseline.json";

/** The baseline's sorted entries, or `null` when no baseline file exists yet — an EMPTY baseline is a baseline. */
export function readBaseline(root = ROOT) {
  const p = join(root, BASELINE_PATH);
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error(`${BASELINE_PATH}: expected an \`entries\` array`);
  const seen = new Set();
  for (const e of parsed.entries) {
    if (typeof e !== "string" || e === "") throw new Error(`${BASELINE_PATH}: entry is not a path string: ${JSON.stringify(e)}`);
    if (seen.has(e)) throw new Error(`${BASELINE_PATH}: duplicate entry ${e}`);
    seen.add(e);
  }
  return [...parsed.entries].sort();
}

export function writeBaseline(findings, root = ROOT) {
  const body = {
    "//": [
      "WI-FL0.1 — modules unreachable from every production root (scripts/knip-production.json),",
      "measured by scripts/check-test-only-modules.mjs. IDENTITY list, two-way: an unlisted",
      "finding fails the gate, and so does an entry that is no longer a finding. Entries only",
      "leave; Phase 3 of the feature-ledger plan deletes or wires each one. Never add by hand:",
      "`node scripts/check-test-only-modules.mjs --update` records the measured set.",
    ],
    entries: [...new Set(findings)].sort(),
  };
  // Written to a SIBLING temporary file and renamed into place. A direct
  // write truncates first, so an interruption or a full disk leaves a
  // half-written baseline — which the next run cannot parse, and which a
  // reviewer reads as a deliberate reset. A rename inside one
  // directory is atomic: a reader sees the old baseline or the new one.
  const target = join(root, BASELINE_PATH);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
  renameSync(tmp, target);
}

export function compareWithBaseline(findings, baseline) {
  const f = new Set(findings);
  const b = new Set(baseline);
  return {
    unlisted: findings.filter((x) => !b.has(x)).sort(),
    stale: baseline.filter((x) => !f.has(x)).sort(),
  };
}

/**
 * What `--update` may write: growth of an EXISTING baseline (`null` means none
 * exists yet) is refused unless explicitly allowed. A baseline that reached
 * zero still exists, so a regression cannot be written through it either.
 */
export function updateDecision(findings, baseline, { allowGrowth = false } = {}) {
  const { unlisted: added, stale: removed } = compareWithBaseline(findings, baseline ?? []);
  return { added, removed, refused: !allowGrowth && baseline !== null && added.length > 0 };
}
