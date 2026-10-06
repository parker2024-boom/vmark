/**
 * Purpose: join the guide's mechanically checkable claims — a constant, a
 *   default chord, an env-var name, a list of names, a file-type table — to
 *   the code that makes each one true (WI-RA15C.10).
 *
 * Each claim was written from the code; this keeps it from drifting. A claim
 * is `{ name, files, check(texts) → string[] }`: `files` names the
 * `DEFAULT_PATHS` keys it reads, and `check` returns one sentence per
 * disagreement. Both sides are read by an anchored pattern, and a pattern
 * that no longer matches is itself a finding (`capture` throws) — a reworded
 * sentence or a renamed constant must not read as agreement.
 *
 * The claim table lives in guideClaimsTable.mjs; this module runs it.
 *
 * Doc-join module contract (consumed by scripts/check-doc-joins.mjs):
 *   `id`, `DEFAULT_PATHS`, `run({ root, paths }) → { findings, info }`.
 *
 * @coordinates-with scripts/lib/docJoins/guideClaimsTable.mjs — the claims
 * @module scripts/lib/docJoins/guideClaims
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLAIMS, CLAIM_PATHS } from "./guideClaimsTable.mjs";

export const id = "guide-claims";

export const DEFAULT_PATHS = CLAIM_PATHS;

/**
 * Run `claims` against `texts` (a map from path key to file text). A claim
 * that throws contributes one finding naming it, so a broken pattern cannot
 * look like a kept promise.
 */
export function checkClaims(claims, texts) {
  const findings = [];
  for (const claim of claims) {
    const missing = claim.files.filter((key) => typeof texts[key] !== "string");
    if (missing.length > 0) {
      findings.push(`${claim.name}: no text for ${missing.join(", ")}`);
      continue;
    }
    try {
      for (const message of claim.check(texts)) findings.push(`${claim.name}: ${message}`);
    } catch (err) {
      findings.push(`${claim.name}: ${err?.message ?? err}`);
    }
  }
  return findings;
}

export async function run({ root, paths }) {
  const texts = {};
  for (const [key, rel] of Object.entries(paths)) texts[key] = readFileSync(resolve(root, rel), "utf8");
  const findings = checkClaims(CLAIMS, texts);
  return { findings, info: [`${CLAIMS.length} claims checked`] };
}
