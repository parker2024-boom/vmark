/**
 * Purpose: the feature ledger's joined inputs — the four baselines, shape-checked
 *   so a malformed one cannot join to an all-zero "clean" column, and the
 *   coverage summary, reported per feature only when it holds every eligible
 *   file.
 *
 * @coordinates-with scripts/gen-feature-ledger.mjs — the generator that joins these
 * @coordinates-with scripts/file-size-baseline.json — oversized-file debt
 * @coordinates-with scripts/mock-boundaries-baseline.json — internal-module mocking
 * @coordinates-with scripts/plugin-store-coupling-baseline.json — plugin->host coupling
 * @module scripts/lib/featureLedgerSources
 */
import path from "node:path";

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The baseline payloads, SHAPE-checked: each container must be the type the
 * join reads and every record must carry the field the join keys on. An
 * EMPTY container is valid — a ratchet that reached zero is the goal, not a
 * shape change — but a missing container, or a record without its key field,
 * would join to an all-zero column that reads as "clean".
 */
export function joinSources({ fileSize, mockB, depX, coupling }) {
  const problems = [];
  // A count is a NON-NEGATIVE SAFE INTEGER. `typeof v === "number"` alone
  // accepted -1, 1.5 and NaN — each of which lands in a column this document
  // promises was measured.
  const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
  const files = fileSize?.files;
  const testFiles = fileSize?.testFiles;
  if (!isPlainObject(files) || !isPlainObject(testFiles)) problems.push("file-size-baseline.json: expected `files` and `testFiles` objects");
  else for (const [k, v] of [...Object.entries(files), ...Object.entries(testFiles)]) {
    if (k.startsWith("//")) continue;
    // An empty key is not a path, and `underAny` would still test it against
    // every feature's paths.
    if (k.trim() === "") problems.push("file-size-baseline.json: a record is keyed by an empty path");
    if (!isCount(v)) problems.push(`file-size-baseline.json: ${k} is not a line count (${JSON.stringify(v)})`);
  }
  const mockRecords = Array.isArray(mockB?.entries) ? mockB.entries : null;
  if (!mockRecords) problems.push("mock-boundaries-baseline.json: expected an `entries` array");
  else mockRecords.forEach((r, i) => { if (!isPlainObject(r) || typeof r.file !== "string" || r.file.trim() === "") problems.push(`mock-boundaries-baseline.json: entry ${i} has no non-empty string \`file\``); });
  const depRecords = Array.isArray(depX) ? depX : null;
  if (!depRecords) problems.push(".dependency-cruiser-known-violations.json: expected a root array");
  else depRecords.forEach((r, i) => { if (!isPlainObject(r) || typeof r.from !== "string" || r.from.trim() === "") problems.push(`.dependency-cruiser-known-violations.json: entry ${i} has no non-empty string \`from\``); });
  const couplingUnits = isPlainObject(coupling?.units) ? coupling.units : null;
  if (!couplingUnits) problems.push("plugin-store-coupling-baseline.json: expected a `units` object");
  else for (const [unit, v] of Object.entries(couplingUnits)) {
    if (unit.startsWith("//")) continue;
    if (unit.trim() === "") problems.push("plugin-store-coupling-baseline.json: a unit is keyed by an empty name");
    const counts = isCount(v) || (isPlainObject(v) && Object.values(v).every(isCount));
    if (!counts) problems.push(`plugin-store-coupling-baseline.json: ${unit} is neither a count nor a map of counts`);
  }
  return { problems, fileSizeFlat: { ...(files ?? {}), ...(testFiles ?? {}) }, mockRecords: mockRecords ?? [], depRecords: depRecords ?? [], couplingUnits: couplingUnits ?? {} };
}

/**
 * Files the app's coverage run can report for a feature: TS/TSX under src/,
 * minus vitest.config.ts's coverage.exclude classes and minus type-only
 * modules (`types.ts`, `*.types.ts`) — those compile to nothing, so v8 never
 * lists them; counting one as "missing" would call a complete summary partial.
 */
export function coverageEligible(srcFiles) {
  return srcFiles.filter((f) =>
    /^src\//.test(f) && /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !/(^|\/)index\.ts$/.test(f) && !/\.config\./.test(f) &&
    !/^src\/(test|assets)\//.test(f) && !/(^|\/)types\.ts$/.test(f) && !/\.types\.ts$/.test(f));
}

/**
 * Per-feature line coverage — only when EVERY eligible file is in the summary.
 * vitest.config.ts sets `coverage.include` (`src/**` TS/TSX), so a full run
 * lists a file no test loads at 0% instead of leaving it out. A summary can
 * still lack files — one written before that include existed, or by a run
 * under another coverage config — and averaging only what IS there would
 * report the measured fraction as the feature's coverage. Partial →
 * `pct: null`, with `seen/expected` so the cell can say so.
 */
export function featureCoverage(covSummary, eligible, root) {
  const expected = eligible.length;
  if (!covSummary) return { pct: null, seen: 0, expected };
  const byRel = new Map();
  for (const [abs, v] of Object.entries(covSummary)) {
    if (abs === "total") continue;
    // `path.relative`, not a string-prefix slice: `/x/vmark-old/src/a.ts`
    // starts with `/x/vmark` and used to be sliced into `old/src/a.ts` — a
    // sibling checkout's file keyed as though it were this tree's.
    // A result that climbs out is not this tree's file.
    let rel = abs;
    if (path.isAbsolute(abs)) {
      rel = path.relative(root, abs);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    }
    byRel.set(rel.split(path.sep).join("/"), v);
  }
  let covered = 0, total = 0, seen = 0;
  for (const f of eligible) {
    const v = byRel.get(f);
    // A record without numeric `lines` is not a measurement of that file, and
    // counting it as `seen` while folding in zeros made a PARTIAL summary look
    // complete and understated the percentage. Not seen →
    // `complete` is false → the cell says so.
    if (!v || typeof v.lines?.covered !== "number" || typeof v.lines?.total !== "number") continue;
    covered += v.lines.covered;
    total += v.lines.total;
    seen++;
  }
  const complete = expected > 0 && seen === expected && total > 0;
  return { pct: complete ? (covered / total) * 100 : null, seen, expected };
}
