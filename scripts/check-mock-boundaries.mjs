#!/usr/bin/env node
/**
 * Mock-boundary identity ratchet (D4).
 *
 * Tests must mock BOUNDARIES (`@tauri-apps/*`, network, fs), not app state.
 * A test that mocks `src/stores/*` re-declares the store's contract by hand;
 * when the real store drifts, the fake keeps passing — the contract-drift
 * hole behind 1,411 `vi.mock("@/…")` calls and 144 `as unknown as` casts.
 * The sanctioned alternatives are the real store (setState/reset in
 * beforeEach) or an explicit store-factory seam with a recorded reason.
 *
 * The baseline is an IDENTITY LIST of (test file, mocking API, resolved
 * module target) triples — never per-file counts, because counts permit
 * like-for-like swaps (remove baselined mock A, add new mock B, net zero
 * passes). Two-way ratchet, house standard: an unbaselined mock fails, and a
 * baselined mock that no longer exists also fails until its entry is deleted
 * (record the win, or it silently becomes headroom for the next regression).
 *
 * Coverage — no variant is documented out of scope:
 *   - `vi.mock("…")`, `vi.doMock("…")`, `vi.mock(import("…"))`
 *   - the receiver resolved through the vitest import, not assumed to be
 *     spelled `vi`: `import { vi as v }` and `import * as vitest` both count
 *     (a rename at the top of a file must not blind the gate to the suite),
 *     while `vi` with no import still counts because `globals: true` needs none
 *   - a constant-backed target (`const P = "@/stores/x"; vi.mock(P)`), resolved
 *     from same-file string bindings; anything still unreadable — an expression,
 *     an interpolated template, a reassigned binding — is recorded as a
 *     violation rather than skipped. "Cannot read" is not "cleared".
 *   - relative-path specifiers resolving into `src/stores/`
 *   - `__mocks__/` directories shadowing a store module
 *   - all test-adjacent files: `*.test.*`, `*.spec.*`, `__tests__/`,
 *     `__mocks__/`, and `src/test/` helpers (setup files live there)
 *
 * Second rule, same detection — same-feature SIBLING mocks. A relative
 * `vi.mock("./x")` / `vi.mock("../x")` of a module that is the app's own logic
 * tests a hand-written fake instead of the code (rule 10's anti-pattern), and
 * so does `vi.mock("@/feature/x")` when `x` sits in the test's own directory
 * or the one its `__tests__/` folder sits in — the alias is a spelling, not a
 * boundary. An alias mock of a module in another directory is not this rule's
 * concern. A
 * relative mock of a boundary wrapper — a module that itself imports
 * `@tauri-apps/*` or a Node builtin — is sanctioned and not counted; so are
 * non-code targets (CSS, raw assets). Zero are allowed and none can be
 * baselined: the frozen list that once held them reached zero and was
 * deleted, and a baseline that brings back a `siblingEntries` key fails
 * closed. The classification is `scripts/lib/mockBoundaries/siblingMocks.mjs`.
 * Detection is a real TS parse (AST call expressions), so the literal in a
 * comment or a string is prose, not a mock.
 *
 * Usage:
 *   node scripts/check-mock-boundaries.mjs [--root <dir>] [--baseline <file>]
 *   node scripts/check-mock-boundaries.mjs --write-baseline   (freeze the store
 *     mocks; refuses while any sibling mock exists)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isMainModule } from "./lib/isMainModule.mjs";
import { extractMockCalls, UNRESOLVED_TARGET } from "./lib/mockBoundaries/mockCalls.mjs";
import { siblingLogicTarget } from "./lib/mockBoundaries/siblingMocks.mjs";
import {
  compareIdentities,
  reportDiff,
  sortTriples,
  reportSiblingMocks,
  validateBaseline,
} from "./lib/mockBoundaries/baseline.mjs";

export { extractMockCalls, UNRESOLVED_TARGET, compareIdentities, validateBaseline };

// ─── Pure, testable core ───

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
// `.stryker-tmp` is Stryker's mutation sandbox — a gitignored full copy of the
// repo. Scanning it double-counts every baselined mock while a measurement runs.
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git", "coverage", ".stryker-tmp"]);

/** Test-adjacent = in scope. Helpers and setup files count: a store mock in a
 *  shared harness leaks into every suite that imports it. */
export function isTestAdjacent(rel) {
  const base = rel.split("/").pop() ?? "";
  if (base.includes(".test.") || base.includes(".spec.")) return true;
  if (rel.includes("/__tests__/") || rel.includes("/__mocks__/")) return true;
  return rel.startsWith("src/test/") || rel.includes("/src/test/");
}

/** Resolve a mock specifier to a repo-relative module path, or null when it
 *  cannot reach `src/stores/` (bare package specifiers are the legitimate
 *  boundary-mock case and are never counted). */
export function resolveStoreTarget(spec, fileRel) {
  let resolved;
  if (spec.startsWith("@/")) resolved = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), spec));
  } else return null;
  resolved = resolved.replace(SOURCE_EXT, "");
  return resolved === "src/stores" || resolved.startsWith("src/stores/") ? resolved : null;
}

function walk(dir, rootLen, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A nested git checkout (e.g. an agent worktree under .claude/worktrees/)
      // is another tree, not this one — scanning it makes the gate's verdict
      // depend on machine-local state that the committed baseline cannot track.
      if (!SKIP_DIRS.has(entry.name) && !existsSync(path.join(full, ".git"))) {
        walk(full, rootLen, out);
      }
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(full.slice(rootLen).split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * Scan a tree and return the sorted identity triples: `stores` (mocks of
 * src/stores/*) and `siblings` (mocks of the app's own logic in the test's
 * own directory, spelled relatively or with the `@/` alias).
 */
export function scanTree(root) {
  const stores = [];
  const siblings = [];
  for (const rel of walk(root, root.length + 1, [])) {
    if (!isTestAdjacent(rel)) continue;

    // A `__mocks__` file shadows the module at the same name one level up;
    // when that module lives in src/stores/, the shadow IS a store mock.
    if (rel.includes("/__mocks__/")) {
      const shadow = rel.replace("/__mocks__/", "/").replace(SOURCE_EXT, "");
      if (shadow === "src/stores" || shadow.startsWith("src/stores/")) {
        stores.push({ file: rel, api: "__mocks__", target: shadow });
      }
    }

    const text = readFileSync(path.join(root, rel), "utf8");
    for (const { api, spec } of extractMockCalls(text, rel)) {
      if (spec === UNRESOLVED_TARGET) {
        stores.push({ file: rel, api, target: UNRESOLVED_TARGET });
        continue;
      }
      const target = resolveStoreTarget(spec, rel);
      if (target !== null) {
        stores.push({ file: rel, api, target });
        continue;
      }
      const sibling = siblingLogicTarget(spec, rel, root);
      if (sibling !== null) siblings.push({ file: rel, api, target: sibling });
    }
  }
  return { stores: sortTriples(stores), siblings: sortTriples(siblings) };
}

// ─── CLI shell ───

const BASELINE_HEADER = [
  "Identity baseline of test-side mocks of src/stores/* — (file, mocking API, resolved target) triples, never counts (counts permit like-for-like swaps).",
  "Checked by scripts/check-mock-boundaries.mjs (pnpm lint:mock-boundaries, in check:all); regenerate ONLY to remove entries via --write-baseline.",
  "Two-way ratchet: an unbaselined store mock fails the gate, and a baselined mock that no longer exists also fails until its entry is deleted — record the win.",
  "Entries only get REMOVED, never added. Instead of mocking a store, use the real store (setState/reset in beforeEach) or an explicit store-factory seam with a recorded reason.",
  "Same-feature sibling mocks of the app's own logic are not listed here because none are allowed: import the real module; mock a module only when it wraps a real boundary (it imports @tauri-apps/* or a Node builtin itself), or mock that boundary directly.",
  "Registered in the WI-16 ratchet manifest (scripts/check-baseline-ratchet.mjs), which re-compares this file against the merge base in CI — so the commit that adds an entry cannot also be the commit that authorizes it.",
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
  const root = path.resolve(args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const baselinePath = path.resolve(args.baseline ?? path.join(root, "scripts", "mock-boundaries-baseline.json"));

  const { stores, siblings } = scanTree(root);

  if (args.write) {
    // Freezing a sibling mock would turn a forbidden mock into a listed one.
    if (reportSiblingMocks(siblings)) process.exit(1);
    const doc = { "//": BASELINE_HEADER, entries: stores };
    writeFileSync(baselinePath, JSON.stringify(doc, null, 2) + "\n");
    const n = stores.length;
    console.log(`✍️  Wrote ${n} identity entr${n === 1 ? "y" : "ies"} to ${baselinePath}`);
    return;
  }

  let entries;
  try {
    const raw = JSON.parse(readFileSync(baselinePath, "utf8"));
    entries = validateBaseline(raw, baselinePath);
  } catch (error) {
    console.error(`❌ Cannot read mock-boundary baseline (${baselinePath}): ${error.message}`);
    console.error("   The gate fails closed — fix the baseline, never delete it to pass.");
    process.exit(1);
  }

  const storeFailed = reportDiff(compareIdentities(stores, entries), "store mock", "entries");
  const siblingFailed = reportSiblingMocks(siblings);
  if (storeFailed || siblingFailed) process.exit(1);

  console.log(
    `✅ Mock-boundary gate held (${stores.length} frozen store mock(s), ` +
      "none added; no sibling logic mocks).",
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
