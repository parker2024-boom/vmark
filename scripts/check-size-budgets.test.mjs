// WI-RA19.9 — a size budget that matches no built file must FAIL the size gate.
//
// Several budgets in .size-limit.cjs name a chunk the bundler names
// (`popupComponents-*`, `markdownSurface-*`). If the bundler renames one, the
// budget has nothing to measure. Two things keep that loud, and both are
// pinned here because neither is ours:
//
//   1. size-limit exits non-zero when a budget's globs match no file. That is
//      the dependency's behaviour, so it is asserted against the INSTALLED
//      CLI: a bump that turns it into a warning fails this test.
//   2. size-limit only notices when ALL of a budget's globs match nothing. A
//      budget listing two positive globs keeps passing when one of them goes
//      dead (also asserted below, so the reason for the rule stays true). So
//      every budget must carry exactly one positive glob.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const budgets = require("../.size-limit.cjs");
const SIZE_LIMIT_BIN = join(root, "node_modules/size-limit/bin.js");

/** Positive and negative globs of a budget, whatever shape `path` has. */
export function splitGlobs(entry) {
  const globs = Array.isArray(entry.path) ? entry.path : [entry.path];
  return {
    positive: globs.filter((g) => typeof g === "string" && !g.startsWith("!")),
    negative: globs.filter((g) => typeof g === "string" && g.startsWith("!")),
  };
}

/** Budgets that could go partly or wholly unmeasured without size-limit noticing. */
export function unsafeBudgets(entries) {
  const failures = [];
  const seen = new Map();
  for (const entry of entries) {
    const { positive } = splitGlobs(entry);
    if (positive.length !== 1) {
      failures.push(`${entry.name}: ${positive.length} positive globs (exactly one is required)`);
      continue;
    }
    const [glob] = positive;
    if (!/^dist\/assets\/[A-Za-z][\w-]*-\*\.js$/.test(glob)) {
      failures.push(`${entry.name}: "${glob}" is not a hash-stripped dist/assets/<name>-*.js glob`);
    }
    if (seen.has(glob)) failures.push(`${entry.name}: same glob as "${seen.get(glob)}"`);
    seen.set(glob, entry.name);
  }
  return failures;
}

describe("the repository's size budgets", () => {
  it("has budgets to check", () => {
    expect(budgets.length).toBeGreaterThan(10);
    expect(budgets.map((b) => b.name)).toContain("EAGER: popupComponents (shared side chunk)");
  });

  it("each carries exactly one positive, hash-stripped glob", () => {
    expect(unsafeBudgets(budgets)).toEqual([]);
  });

  it("budget names are unique, so a failure names one budget", () => {
    const names = budgets.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("unsafeBudgets", () => {
  const ok = { name: "a", path: "dist/assets/a-*.js" };

  it("accepts one positive glob, with or without negations", () => {
    expect(unsafeBudgets([ok, { name: "b", path: ["dist/assets/b-*.js", "!dist/assets/b-x-*.js"] }])).toEqual([]);
  });

  it.each([
    ["two positive globs", { name: "two", path: ["dist/assets/a-*.js", "dist/assets/b-*.js"] }],
    ["only negations", { name: "neg", path: ["!dist/assets/a-*.js"] }],
    ["a hash-pinned name", { name: "pinned", path: "dist/assets/index-BUAvxpLj.js" }],
    ["a glob outside dist/assets", { name: "outside", path: "dist/a-*.js" }],
    ["a missing path", { name: "none" }],
  ])("rejects %s", (_label, entry) => {
    expect(unsafeBudgets([entry])).toHaveLength(1);
  });

  it("rejects two budgets sharing a glob", () => {
    expect(unsafeBudgets([ok, { name: "dup", path: "dist/assets/a-*.js" }])).toEqual(['dup: same glob as "a"']);
  });
});

describe("the installed size-limit CLI", () => {
  let dir;
  const run = (entries) => {
    const config = join(dir, "config.cjs");
    writeFileSync(config, `module.exports = ${JSON.stringify(entries)};\n`);
    return spawnSync(process.execPath, [SIZE_LIMIT_BIN, "--config", config], { cwd: root, encoding: "utf8" });
  };
  const budget = (name, path) => ({ name, path, limit: "10 kB", brotli: false });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vmark-size-budgets-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/present-abc123.js"), "export const a = 1;\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when every budget matches a file", () => {
    const result = run([budget("present", join(dir, "assets/present-*.js"))]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails when a budget's glob matches no file", () => {
    const result = run([
      budget("present", join(dir, "assets/present-*.js")),
      budget("renamed", join(dir, "assets/renamed-*.js")),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/can.t find files/);
  });

  it("does NOT fail when only one of several positive globs is dead — hence one glob per budget", () => {
    const result = run([budget("mixed", [join(dir, "assets/present-*.js"), join(dir, "assets/renamed-*.js")])]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
