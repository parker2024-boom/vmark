#!/usr/bin/env node
/**
 * Plugin→host coupling ratchet — FOUR channels.
 *
 * A plugin that imports `@/stores/…` reaches into the app's Zustand singletons.
 * That is the property which makes it unshippable as a standalone/third-party
 * extension — you cannot hand someone a plugin that mutates your global state.
 * It is therefore the binding constraint on ADR-015's goal, not cross-plugin
 * imports.
 *
 * Why this gate exists: a maintainer review of the extension goal's progress
 * measured the whole extension re-architecture as a delta and found
 *
 *   cross-plugin imports  339 → 264  (−22%, and `plugin-isolation` gates it)
 *   plugin files → stores  97 →  98  (+1,  and NOTHING gated it)
 *
 * across 192 commits whose stated purpose was decoupling. The axis that
 * improved is the one dependency-cruiser could already see. This makes the
 * other axis visible.
 *
 * Why FOUR channels and not just `@/stores`: that count reached zero, but the
 * app's services are themselves store-coupled (`resolveMediaSrc` →
 * documentStore + tabStore; `unifiedHistory` → five stores). A plugin that
 * imports `@/services` is transitively coupled and equally un-liftable, and the
 * single-channel gate could not see it. `@/services`, `@/hooks` and
 * `@/components` are measured beside `@/stores`.
 *
 * Why per unit AND per channel: a bare count lets a fixed plugin pay for a
 * newly-coupled one — net zero passes while the ecosystem gets no closer to
 * extractable. Freezing per (unit, channel) (the pattern of
 * `scripts/file-size-baseline.json`) fails on BOTH halves of that swap,
 * including a swap that trades one channel for another inside one plugin.
 *
 * Detection is a real TS parse (AST module specifiers), never a grep, in EVERY
 * channel including the legacy `@/stores` one: a literal in a comment or a
 * string is prose. Type-only imports DO count — a plugin depending on the app's
 * type module cannot be lifted out either. Relative specifiers that resolve
 * into `src/stores/` &co. count the same as their `@/` spelling.
 *
 * The baseline ratchets DOWN only, and refuses to go stale: improving a plugin
 * fails the gate until the win is locked into the baseline file. Never raise a
 * number — decouple the file instead (move host reads to the call site, pass
 * state in as a parameter, or declare a seam under `plugins/shared/`).
 *
 * Usage:
 *   node scripts/check-plugin-store-coupling.mjs [--root <dir>] [--baseline <file>]
 *   node scripts/check-plugin-store-coupling.mjs --write-baseline   (freeze reality)
 *
 * @coordinates-with scripts/lib/pluginStoreCouplingScan.mjs — the measurement (AST import scan)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isMainModule } from "./lib/isMainModule.mjs";
import { CHANNELS, countsOf, scanCoupling } from "./lib/pluginStoreCouplingScan.mjs";

export {
  CHANNELS,
  extractImportSpecifiers,
  channelOf,
  scanCoupling,
  countsOf,
} from "./lib/pluginStoreCouplingScan.mjs";

const CHANNEL_SET = new Set(CHANNELS);

/**
 * Compare measured coupling against the frozen baseline.
 *
 * Pure, so it is unit-testable without a filesystem. Both inputs map a UNIT
 * (plugin directory name, or a bare filename for loose files directly under
 * `src/plugins/`) to a per-channel count of non-test files that reach that
 * channel.
 *
 * A (unit, channel) pair is a violation when it is new, grew, shrank, or
 * disappeared — the last two because an unlocked win silently becomes headroom
 * for the next regression.
 *
 * @returns violations sorted by unit then channel, so CI output is stable.
 */
export function findCouplingViolations(actual, baseline) {
  const units = new Set([...Object.keys(actual), ...Object.keys(baseline)]);
  const violations = [];

  for (const unit of [...units].sort()) {
    const now = actual[unit] ?? {};
    const was = baseline[unit] ?? {};
    const channels = new Set([...Object.keys(now), ...Object.keys(was)]);

    for (const channel of [...channels].sort()) {
      const a = now[channel] ?? 0;
      const b = was[channel] ?? 0;
      if (a === b) continue;

      let kind;
      if (b === 0) kind = "new";
      else if (a === 0) kind = "fixed";
      else if (a > b) kind = "grew";
      else kind = "stale";

      violations.push({ unit, channel, kind, actual: a, baseline: b });
    }
  }

  return violations;
}

/** Fail loudly on malformed baseline data — a half-read baseline must never
 *  read as "nothing frozen" (fail closed). */
export function validateBaseline(raw, label) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label}: expected a JSON object with a "units" object`);
  }
  const units = raw.units;
  if (typeof units !== "object" || units === null || Array.isArray(units)) {
    throw new Error(`${label}: "units" must be an object of { unit: { channel: count } }`);
  }
  for (const [unit, channels] of Object.entries(units)) {
    if (typeof channels !== "object" || channels === null || Array.isArray(channels)) {
      throw new Error(`${label}: unit "${unit}" must map channels to counts`);
    }
    for (const [channel, count] of Object.entries(channels)) {
      if (!CHANNEL_SET.has(channel)) {
        throw new Error(`${label}: unknown channel "${channel}" on unit "${unit}"`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`${label}: ${unit}/${channel} count must be a non-negative integer`);
      }
    }
  }
  return units;
}

// ─── CLI shell ───

const EXPLAIN = {
  new: "is NEW to the baseline — a plugin was born coupled to the app",
  grew: "gained coupling",
  stale: "improved; lock the win in",
  fixed: "is fully decoupled on this channel; remove it from the baseline",
};

const BASELINE_HEADER = [
  "Frozen plugin->host coupling, per plugin unit and per channel (@/stores, @/services, @/hooks, @/components).",
  "A plugin importing any of them cannot ship as a standalone extension - the app's services are themselves store-coupled, so @/services is transitive @/stores. The policy is .claude/rules/00-engineering-principles.md; the gate is scripts/check-plugin-store-coupling.mjs.",
  "Checked by pnpm lint:store-coupling (in check:all). Two-way ratchet: a count above baseline fails, and a count below baseline also fails until the win is recorded here.",
  "Ratchets DOWN only: never raise a number. Decouple the file instead - read host state at the call site, pass it in as a parameter, or declare a seam under plugins/shared/.",
];

function parseArgs(argv) {
  const args = { root: null, baseline: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--baseline") args.baseline = argv[++i];
    else if (argv[i] === "--write-baseline") args.write = true;
    else {
      console.error(`❌ Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(
    args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const baselinePath = path.resolve(
    args.baseline ?? path.join(root, "scripts", "plugin-store-coupling-baseline.json"),
  );

  const scan = scanCoupling(root);
  const actual = countsOf(scan);

  if (args.write) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ "//": BASELINE_HEADER, units: actual }, null, 2) + "\n",
    );
    console.log(`✍️  Froze ${Object.keys(actual).length} coupled unit(s) into ${baselinePath}`);
    return;
  }

  let baseline;
  try {
    baseline = validateBaseline(JSON.parse(readFileSync(baselinePath, "utf8")), baselinePath);
  } catch (error) {
    console.error(`❌ Cannot read coupling baseline (${baselinePath}): ${error.message}`);
    console.error("   The gate fails closed — fix the baseline, never delete it to pass.");
    process.exit(1);
  }

  const violations = findCouplingViolations(actual, baseline);
  const total = Object.values(actual).reduce(
    (sum, channels) => sum + Object.values(channels).reduce((a, b) => a + b, 0),
    0,
  );

  if (violations.length === 0) {
    console.log(
      `✅ Plugin→host coupling held (${total} coupled file-channel pair(s) across ${Object.keys(actual).length} plugins).`,
    );
    return;
  }

  console.error(`\n❌ Plugin→host coupling changed in ${violations.length} unit/channel pair(s):\n`);
  for (const v of violations) {
    console.error(
      `   ${v.unit} @/${v.channel} — ${EXPLAIN[v.kind]} (baseline ${v.baseline}, now ${v.actual})`,
    );
    if (v.kind === "new" || v.kind === "grew") {
      for (const file of scan[v.unit]?.[v.channel] ?? []) console.error(`      ${file}`);
    }
  }

  const regressions = violations.filter((v) => v.kind === "new" || v.kind === "grew");
  if (regressions.length > 0) {
    console.error(
      "\n   A plugin that imports @/stores, @/services, @/hooks or @/components cannot\n" +
        "   ship as a standalone extension — the app's services are themselves\n" +
        "   store-coupled, so an @/services import is transitive @/stores coupling.\n" +
        "   Read host state at the call site, pass it in as a parameter, or declare a\n" +
        "   seam under plugins/shared/. This baseline ratchets DOWN only.\n",
    );
  }
  if (regressions.length < violations.length) {
    console.error(
      "\n   Some of these are IMPROVEMENTS — record the win in\n" +
        "   scripts/plugin-store-coupling-baseline.json so it cannot silently become\n" +
        "   headroom for the next regression.\n",
    );
  }

  process.exit(1);
}

// Only run when invoked directly, so the test can import the pure helpers.
if (isMainModule(import.meta.url)) {
  main();
}
