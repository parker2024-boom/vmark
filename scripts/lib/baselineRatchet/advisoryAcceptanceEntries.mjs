/**
 * The dependency-advisory acceptance registries in the baseline ratchet
 * manifest: npm advisories and RustSec findings a maintainer reviewed and
 * accepted.
 *
 * Purpose: both registries share one contract — an addition REPORTS, because
 * the gate that owns each registry already refuses an entry with no reason
 * and one whose finding has gone away. Kept together so the two stay alike;
 * spread into `MANIFEST.entries` by the main manifest, whose header documents
 * the entry schema.
 *
 * @coordinates-with scripts/baselineRatchetManifest.mjs — spreads these into MANIFEST.entries
 * @coordinates-with scripts/check-npm-audit.mjs — owns the npm registry's own rules
 * @coordinates-with scripts/check-cargo-audit.mjs — owns the RustSec registry's own rules
 * @module scripts/lib/baselineRatchet/advisoryAcceptanceEntries
 */

export const ADVISORY_ACCEPTANCE_ENTRIES = [
  {
    // Reviewed npm advisory acceptances. An addition
    // REPORTS rather than fails: a genuinely new advisory in a dev-only
    // dependency chain is an ordinary event, and the gate that matters —
    // `check-npm-audit.mjs` — already refuses an entry with no stated reason
    // and refuses one whose advisory has gone away.
    path: "scripts/npm-audit-baseline.json",
    checks: [{ mode: "identity", at: "accepted", shape: "object-keys", onAdd: "report" }],
  },
  {
    // Reviewed RustSec acceptances: unmaintained, unsound and yanked crates
    // as well as vulnerabilities. An addition REPORTS for the same reason as
    // the npm registry above: `check-cargo-audit.mjs` already refuses an
    // entry with no reason, one that names the wrong crate or kind, and one
    // whose finding has gone away.
    path: "scripts/cargo-audit-baseline.json",
    checks: [{ mode: "identity", at: "accepted", shape: "object-keys", onAdd: "report" }],
  },
];
