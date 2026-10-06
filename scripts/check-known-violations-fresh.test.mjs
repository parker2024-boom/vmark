// WI-RA24.6 — every edge frozen in `.dependency-cruiser-known-violations.json`
// still exists.
//
// `pnpm lint:deps` runs depcruise with `--ignore-known`, which fails on a NEW
// violation but only WARNS about a stale one ("‼ 1 stale known violations")
// and exits 0. A fixed edge therefore stayed frozen: the list kept an entry
// for an import that no longer existed, and `scripts/extension-budget.json`
// kept counting it as debt. This runs depcruise's own shrink-only rewrite
// against a copy of the list and fails when it would remove anything, naming
// each stale edge. Shrink the real list with
//   pnpm exec depcruise src --config .dependency-cruiser.cjs --baseline --baseline-mode shrink-only
// and lower `maxKnownViolations` to match.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPCRUISE = path.join(REPO, "node_modules", ".bin", "depcruise");
const KNOWN = path.join(REPO, ".dependency-cruiser-known-violations.json");

const scratch = mkdtempSync(path.join(tmpdir(), "known-violations-fresh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const edge = (v) => `${v.from} → ${v.to} (${v.rule?.name ?? "?"})`;

/** Run depcruise's shrink-only rewrite on a copy of `entries`; return what it kept. */
function shrinkOnly(entries, name) {
  const copy = path.join(scratch, `${name}.json`);
  writeFileSync(copy, JSON.stringify(entries, null, 2));
  const run = spawnSync(
    DEPCRUISE,
    ["src", "--config", ".dependency-cruiser.cjs", "--baseline", copy, "--baseline-mode", "shrink-only"],
    { cwd: REPO, encoding: "utf8" },
  );
  expect(run.status, `depcruise failed:\n${run.stderr}\n${run.stdout}`).toBe(0);
  return JSON.parse(readFileSync(copy, "utf8"));
}

const committed = JSON.parse(readFileSync(KNOWN, "utf8"));

describe(".dependency-cruiser-known-violations.json holds no stale edge", () => {
  it("is a non-empty list the gate can read", () => {
    expect(Array.isArray(committed)).toBe(true);
    expect(committed.length).toBeGreaterThan(0);
  });

  it("keeps only edges that still exist", () => {
    const kept = new Set(shrinkOnly(committed, "committed").map(edge));
    const stale = committed.map(edge).filter((e) => !kept.has(e));
    expect(stale, `stale known violation(s) — shrink the list:\n${stale.join("\n")}`).toEqual([]);
  });

  it("would catch a stale edge (the check is not a no-op)", () => {
    const planted = {
      ...committed[0],
      from: "src/plugins/doesNotExist/index.ts",
      to: "src/plugins/neitherDoesThis/index.ts",
    };
    const kept = shrinkOnly([...committed, planted], "planted").map(edge);
    expect(kept).not.toContain(edge(planted));
    expect(kept).toHaveLength(committed.length);
  });
});
