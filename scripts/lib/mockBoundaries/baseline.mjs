/**
 * Purpose: read, compare and report the mock-boundary identity baseline — a
 * list of (test file, mocking API, resolved target) triples, `entries`, for
 * store mocks — and report same-feature sibling mocks, of which none are
 * allowed. Identity, never counts: a count permits a like-for-like swap.
 *
 * The list ratchets two ways: an unlisted mock fails, and a listed mock that
 * no longer exists fails until its entry is deleted. Malformed data fails
 * closed — a half-read baseline must never read as "no entries". Sibling mocks
 * have no list: a baseline carrying a `siblingEntries` key fails closed.
 *
 * @coordinates-with scripts/check-mock-boundaries.mjs — the gate's CLI
 * @coordinates-with scripts/mock-boundaries-baseline.json — the data
 * @coordinates-with scripts/baselineRatchetManifest.mjs — `entries` is merge-base ratcheted
 * @module scripts/lib/mockBoundaries/baseline
 */

function assertTriples(list, label, field) {
  for (const e of list) {
    if (typeof e?.file !== "string" || typeof e?.api !== "string" || typeof e?.target !== "string") {
      throw new Error(`${label}: malformed ${field} entry ${JSON.stringify(e)}`);
    }
  }
}

/**
 * The store-mock list. Fail loudly on malformed data (fail closed), and on a
 * `siblingEntries` key in any form: sibling mocks cannot be baselined.
 */
export function validateBaseline(raw, label) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label}: expected a JSON object with an "entries" array`);
  }
  if (Object.hasOwn(raw, "siblingEntries")) {
    throw new Error(
      `${label}: "siblingEntries" is not allowed — sibling logic mocks cannot be baselined. ` +
        "Delete the key and remove the mocks instead.",
    );
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error(`${label}: "entries" must be an array of {file, api, target}`);
  }
  assertTriples(raw.entries, label, "entries");
  return raw.entries;
}

const key = (e) => `${e.file} :: ${e.api} :: ${e.target}`;

/** Sort and de-duplicate triples by identity. */
export function sortTriples(triples) {
  const seen = new Map(triples.map((e) => [key(e), e]));
  return [...seen.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Identity comparison — set difference in both directions. */
export function compareIdentities(actual, baseline) {
  const actualKeys = new Set(actual.map(key));
  const baseKeys = new Set(baseline.map(key));
  return {
    added: actual.filter((e) => !baseKeys.has(key(e))),
    removed: baseline.filter((e) => !actualKeys.has(key(e))),
  };
}

const STORE_ADVICE =
  "   Tests mock boundaries, not app state. Use the real store (setState/reset\n" +
  "   in beforeEach) or an explicit store-factory seam with a recorded reason.\n" +
  "   The baseline ratchets DOWN only — never add an entry to pass.";
const SIBLING_ADVICE =
  "   A mock of a sibling module that is the app's own logic (spelled relatively\n" +
  "   or with @/) tests a fake, not the code. Import the real sibling. Mock a\n" +
  "   module only when it wraps a real boundary (it imports @tauri-apps/* or a\n" +
  "   Node builtin itself) — or mock that boundary directly. None are allowed,\n" +
  "   and there is no baseline to list one in.";

/** Print every sibling logic mock to stderr. Returns whether there were any. */
export function reportSiblingMocks(siblings) {
  if (siblings.length === 0) return false;
  console.error(`\n❌ ${siblings.length} test-side sibling logic mock(s) — none are allowed:\n`);
  for (const e of siblings) console.error(`   ${e.file} — ${e.api} → ${e.target}`);
  console.error(`\n${SIBLING_ADVICE}`);
  return true;
}

/**
 * Print the store list's differences to stderr. `noun` names the kind, `field`
 * the baseline key. Returns whether it failed.
 */
export function reportDiff({ added, removed }, noun, field) {
  if (added.length > 0) {
    console.error(`\n❌ ${added.length} test-side ${noun}(s) NOT in the identity baseline (${field}):\n`);
    for (const e of added) console.error(`   ${e.file} — ${e.api} → ${e.target}`);
    console.error(`\n${STORE_ADVICE}`);
  }
  if (removed.length > 0) {
    console.error(`\n❌ ${removed.length} baselined ${noun}(s) no longer exist — record the win:\n`);
    for (const e of removed) console.error(`   ${e.file} — ${e.api} → ${e.target}`);
    console.error(
      `\n   Delete these entries from "${field}" in scripts/mock-boundaries-baseline.json so the\n` +
        "   improvement cannot silently become headroom for the next regression.",
    );
  }
  return added.length > 0 || removed.length > 0;
}
