/**
 * Purpose: assemble the feature ledger's rows — one inventory per feature under
 *   single ownership, the history the Commits / Last touch / freshness columns
 *   read, coverage provenance, and the per-feature row that joins them.
 *
 * @coordinates-with scripts/gen-feature-ledger.mjs — the generator that renders these rows
 * @coordinates-with scripts/lib/featureMeasure.mjs — the measurements each row takes
 * @coordinates-with scripts/lib/featureLedgerSources.mjs — the baselines and coverage joined in
 * @coordinates-with scripts/lib/featureHistory.mjs — touches through deletions and renames
 * @module scripts/lib/featureLedgerRows
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveOwners } from "./featureOwnership.mjs";
import { LOG_ARGS, parseNameStatusLog, touchesByFeature } from "./featureHistory.mjs";
import { countLines, featureInventory, normalizePaths, run, tokeiCode } from "./featureMeasure.mjs";
import { coverageEligible, featureCoverage } from "./featureLedgerSources.mjs";

/**
 * History as the Commits, Last touch and freshness columns need it: each
 * feature's touching commits (through deletions and renames — see
 * scripts/lib/featureHistory.mjs), the commits inside the churn window, and a
 * memoised `sha..HEAD` set per verified commit.
 */
export function readHistory(spine, since, git) {
  const touches = touchesByFeature(parseNameStatusLog(git(...LOG_ARGS)), spine);
  const hashes = (...args) => new Set(git("rev-list", ...args).split("\n").filter(Boolean));
  const inWindow = hashes(`--since=${since}`, "HEAD");
  const ranges = new Map();
  const sinceVerified = (sha) => {
    if (!ranges.has(sha)) ranges.set(sha, hashes(`${sha}..HEAD`));
    return ranges.get(sha);
  };
  return { touches, inWindow, sinceVerified };
}

/** One ledger row: every column joined or measured for one spine feature. */
export function measureFeature(f, ctx) {
  const paths = normalizePaths(f.paths);
  const { src: srcFiles, test: testFiles } = ctx.inventory.get(f.name);
  const owns = (file) => ctx.owner.get(file) === f.name;
  // Coupling units are bare plugin/module names ("codemirror", "toolbarActions"),
  // so match the LAST path segment rather than searching the whole string — a
  // substring test makes "svg" match "src/plugins/svgSomethingElse".
  const coup = Object.entries(ctx.couplingUnits)
    .filter(([unit]) => paths.some((p) => p.split("/").pop() === unit))
    .reduce((n, [, v]) => n + (typeof v === "number" ? v : Object.values(v || {}).reduce((a, b) => a + (b || 0), 0)), 0);
  const touches = ctx.history.touches.get(f.name) ?? [];
  // Ledger freshness: commits to this feature's files since the OLDEST commit
  // any of its ledger blocks was verified against. `null` (printed `--`) when
  // no ledger is present or no block describes the feature.
  const shas = [...new Set((ctx.ledgerBlocks.get(f.name) ?? []).map((b) => b.verified).filter(Boolean))];
  const sinceLedger = shas.length === 0 ? null
    : Math.max(...shas.map((sha) => { const range = ctx.history.sinceVerified(sha); return touches.filter((t) => range.has(t.hash)).length; }));
  return {
    name: f.name, flag: f.flag, flagDefault: f.flagDefault, doc: f.doc,
    code: tokeiCode(srcFiles),
    srcFiles: srcFiles.length,
    testFiles: testFiles.length,
    testLines: testFiles.reduce((n, x) => n + countLines(readFileSync(path.join(ctx.root, x), "utf8")), 0),
    cov: featureCoverage(ctx.covSummary, coverageEligible(srcFiles), ctx.root),
    bigFiles: Object.keys(ctx.fileSizeFlat).filter(owns).length,
    mocks: ctx.mockRecords.filter((r) => owns(r.file)).length,
    dep: ctx.depRecords.filter((r) => owns(r.from)).length,
    coup,
    commits: touches.filter((t) => ctx.history.inWindow.has(t.hash)).length,
    last: touches[0]?.date ?? "--",
    blocks: (ctx.ledgerBlocks.get(f.name) ?? []).length,
    sinceLedger,
  };
}

/**
 * ONE inventory per feature, consumed by the coverage-provenance scan and by
 * every measured column. SINGLE OWNERSHIP: a file under two claims (a folder
 * and a file inside it) is measured once, for the most specific claim — the
 * rule scripts/check-feature-map.mjs enforces. Without it 90 files were
 * counted under two features.
 */
export function ownedInventory(spine, runner = run) {
  const raw = new Map(spine.features.map((f) => [f.name, featureInventory(normalizePaths(f.paths), runner)]));
  const { owner } = resolveOwners(spine, [...new Set([...raw.values()].flatMap((v) => v.all))]);
  const inventory = new Map([...raw].map(([name, v]) => {
    const mine = (file) => owner.get(file) === name;
    return [name, { all: v.all.filter(mine), code: v.code.filter(mine), src: v.src.filter(mine), test: v.test.filter(mine) }];
  }));
  return { inventory, owner };
}

/** The ledger's blocks grouped by spine feature; each block carries the commit its own area was verified at. */
export function ledgerBlocksByFeature(ledger) {
  const out = new Map();
  for (const b of ledger?.blocks ?? []) {
    const name = b.fields.feature;
    if (!name) continue;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(b);
  }
  return out;
}

/**
 * COVERAGE PROVENANCE. Nothing ties coverage/coverage-summary.json to the tree
 * it was measured on, so a summary from an older checkout was reported as this
 * tree's coverage for as long as the filenames still matched.
 * There is no commit stamp in the summary, so the check is the honest one
 * available: if any measured source is NEWER than the summary, it did not
 * measure this tree, and the columns say `--` rather than a number from
 * somewhere else.
 */
export function coverageForTree(root, inventory, summary) {
  if (summary === null) return { covSummary: null, covStale: false };
  const summaryAt = statSync(path.join(root, "coverage/coverage-summary.json")).mtimeMs;
  const newest = [...inventory.values()].flatMap((files) => files.code).reduce((max, rel) => {
    const st = statSync(path.join(root, rel), { throwIfNoEntry: false });
    return st && st.mtimeMs > max ? st.mtimeMs : max;
  }, 0);
  return newest > summaryAt ? { covSummary: null, covStale: true } : { covSummary: summary, covStale: false };
}
