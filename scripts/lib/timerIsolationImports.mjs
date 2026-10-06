/**
 * Purpose: answer, for the timer-isolation gate, "is this named import a sleep
 * helper, and which parameter is its duration?" — by resolving the import to
 * a file in the tree and reading what that module declares or re-exports.
 *
 * Without this, moving the `new Promise(r => setTimeout(r, N))` idiom into a
 * shared test utility hid every sleep that called it.
 *
 * Key decisions:
 *   - Only specifiers that name a file in this tree are followed: relative
 *     paths and the `@/` alias for `src/`. A package import is not test code
 *     this repository controls.
 *   - Re-exports (`export { x } from`, `export * from`) are followed, with a
 *     visited set so a cycle ends instead of recursing.
 *   - An import that resolves to no file, or to a file that does not parse,
 *     is not a sleep: the gate reports what it can prove. The test file
 *     itself failing to parse is still the gate's loud failure.
 *
 * @coordinates-with scripts/check-test-timer-isolation.mjs — the gate that asks
 * @coordinates-with scripts/check-test-timer-isolation.scan.mjs — `sleepExportsOf` reads each module
 * @module scripts/lib/timerIsolationImports
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sleepExportsOf } from "../check-test-timer-isolation.scan.mjs";

const CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Repo-relative module file for `spec` imported from `fromRel`, or null. */
function resolveModule(root, fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  } else return null;
  for (const suffix of CANDIDATES) {
    const rel = base + suffix;
    const full = path.join(root, rel);
    if (/\.tsx?$/.test(rel) && existsSync(full) && statSync(full).isFile()) return rel;
  }
  return null;
}

/**
 * A resolver bound to one tree. Returns `importedSleepHelper(fromRel)`, the
 * callback `scanTestClockUsage` takes for the test file at `fromRel`.
 */
export function importedSleepHelpers(root) {
  const exportsCache = new Map();
  const exportsOf = (rel) => {
    if (!exportsCache.has(rel)) {
      let value = null;
      try {
        value = sleepExportsOf(readFileSync(path.join(root, rel), "utf8"), rel);
      } catch {
        value = null; // An unparseable utility proves no sleep; see the header.
      }
      exportsCache.set(rel, value);
    }
    return exportsCache.get(rel);
  };

  const lookup = (fromRel, spec, name, visited) => {
    const rel = resolveModule(root, fromRel, spec);
    if (rel === null || visited.has(`${rel}#${name}`)) return undefined;
    visited.add(`${rel}#${name}`);
    const mod = exportsOf(rel);
    if (mod === null) return undefined;
    if (mod.helpers.has(name)) return mod.helpers.get(name);
    for (const re of mod.reexports) {
      if (re.exported !== "*" && re.exported !== name) continue;
      const found = lookup(rel, re.spec, re.imported === "*" ? name : re.imported, visited);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return (fromRel) => (spec, name) => lookup(fromRel, spec, name, new Set());
}
