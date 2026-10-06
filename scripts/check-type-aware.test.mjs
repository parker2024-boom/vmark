// WI-RA13A.4 — the type-aware lint ratchet fails on a new or grown finding, on an unrecorded fix, and on a run it cannot read
/**
 * Runs the REAL `scripts/check-type-aware.mjs` with a scratch directory as its
 * working directory. The scratch tree carries a config exporting
 * `TYPE_AWARE_RULES`, a baseline, and a stub `node_modules/.bin/eslint` that
 * prints a canned JSON report — so no TypeScript `Program` is built and the
 * test measures only the gate's own logic: report + baseline -> exit code.
 *
 * @coordinates-with scripts/check-type-aware.mjs — the gate under test
 * @module scripts/check-type-aware.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-type-aware.mjs");

const FLOATING = "@typescript-eslint/no-floating-promises";
const MISUSED = "@typescript-eslint/no-misused-promises";
const CONFIG = `export const TYPE_AWARE_RULES = ${JSON.stringify([FLOATING, MISUSED])};\nexport default [];\n`;

/**
 * @param {object} o
 * @param {Record<string, string[]> | string} o.report  file -> rule ids, or raw stdout
 * @param {object | null} o.baseline  `files` map, or null for no baseline file
 */
function scratch({ report = {}, baseline = {}, exit = 0, config = CONFIG, stderr = "" }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "type-aware-")));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  if (config !== null) writeFileSync(path.join(root, "eslint.typeaware.config.mjs"), config);
  if (baseline !== null) {
    writeFileSync(
      path.join(root, "scripts/type-aware-baseline.json"),
      typeof baseline === "string" ? baseline : JSON.stringify({ files: baseline }),
    );
  }
  const stdout =
    typeof report === "string"
      ? report
      : JSON.stringify(
          Object.entries(report).map(([rel, rules]) => ({
            filePath: path.join(root, rel),
            messages: rules.map((ruleId) => ({ ruleId, severity: 2, message: "x" })),
          })),
        );
  writeFileSync(path.join(root, "eslint.out"), stdout);
  writeFileSync(path.join(root, "eslint.err"), stderr);
  const stub = path.join(root, "node_modules", ".bin", "eslint");
  writeFileSync(stub, `#!/bin/bash\ncat "${root}/eslint.out"\ncat "${root}/eslint.err" >&2\nexit ${exit}\n`);
  chmodSync(stub, 0o755);
  return root;
}

function run(root, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  return { ...r, out: r.stdout + r.stderr };
}

const readBaseline = (root) => JSON.parse(readFileSync(path.join(root, "scripts/type-aware-baseline.json"), "utf8"));

describe("check-type-aware.mjs — the ratchet, both directions", () => {
  it("exits 0 when a clean run meets an empty baseline", () => {
    const r = run(scratch({ report: { "src/a.ts": [], "src/b.ts": [] } }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("type-aware lint OK — 0 violations, matching baseline (0 files)");
  });

  it("exits 0 when findings match the baseline per file and per rule", () => {
    const r = run(
      scratch({
        report: { "src/a.ts": [FLOATING, FLOATING, MISUSED], "src/b.ts": [] },
        baseline: { "src/a.ts": { "no-floating-promises": 2, "no-misused-promises": 1 } },
        exit: 1,
      }),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("3 violations, matching baseline (1 files)");
  });

  it("a finding in a file with no baseline entry fails as NEW", () => {
    const r = run(scratch({ report: { "src/a.ts": [FLOATING] }, exit: 1 }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("NEW    src/a.ts :: no-floating-promises (1 new)");
  });

  it("a different RULE in an already-baselined file fails as NEW — no like-for-like swap", () => {
    const r = run(
      scratch({
        report: { "src/a.ts": [MISUSED] },
        baseline: { "src/a.ts": { "no-floating-promises": 1 } },
        exit: 1,
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("NEW    src/a.ts :: no-misused-promises (1 new)");
  });

  it("a fix in one file does not pay for a new finding in another", () => {
    const r = run(
      scratch({
        report: { "src/a.ts": [], "src/b.ts": [FLOATING] },
        baseline: { "src/a.ts": { "no-floating-promises": 1 } },
        exit: 1,
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("NEW    src/b.ts :: no-floating-promises");
  });

  it("a grown count fails as GREW", () => {
    const r = run(
      scratch({
        report: { "src/a.ts": [FLOATING, FLOATING, FLOATING] },
        baseline: { "src/a.ts": { "no-floating-promises": 2 } },
        exit: 1,
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("GREW   src/a.ts :: no-floating-promises 2 -> 3");
  });

  it("a fixed finding fails until the win is recorded", () => {
    const r = run(
      scratch({
        report: { "src/a.ts": [FLOATING] },
        baseline: { "src/a.ts": { "no-floating-promises": 2 } },
        exit: 1,
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("FIXED  src/a.ts :: no-floating-promises 2 -> 1");
  });

  it("a baselined file that is now entirely clean fails as FIXED", () => {
    const r = run(
      scratch({ report: { "src/b.ts": [] }, baseline: { "src/gone.ts": { "no-misused-promises": 1 } } }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("FIXED  src/gone.ts :: no-misused-promises 1 -> 0");
  });

  it("rules the config does not declare are not counted", () => {
    const r = run(
      scratch({ report: { "src/a.ts": ["react-hooks/rules-of-hooks", "no-unused-vars", null] }, exit: 1 }),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("0 violations");
  });
});

describe("check-type-aware.mjs — a run it cannot read never passes", () => {
  it.each([
    ["eslint printed nothing and failed", { report: "", exit: 2, stderr: "Oops! Something went wrong!\n" }, "eslint produced no output"],
    ["eslint printed nothing and exited 0", { report: "", exit: 0 }, "refusing to pass"],
    ["unparseable JSON", { report: "[{", exit: 1 }, "could not parse eslint JSON output"],
    ["a report with zero files", { report: "[]" }, "eslint linted zero files"],
    ["a report that is not an array", { report: JSON.stringify({ results: [] }) }, "eslint linted zero files"],
    ["a missing baseline", { report: { "src/a.ts": [] }, baseline: null }, "type-aware-baseline.json missing"],
    ["a config that exports no rule list", { report: { "src/a.ts": [] }, config: "export default [];\n" }, "does not export TYPE_AWARE_RULES"],
    ["a config that exports an empty rule list", { report: { "src/a.ts": [] }, config: "export const TYPE_AWARE_RULES = [];\n" }, "does not export TYPE_AWARE_RULES"],
    ["a missing config", { report: { "src/a.ts": [] }, config: null }, "eslint.typeaware.config.mjs not found"],
  ])("%s -> exit 64", (_label, opts, message) => {
    const r = run(scratch(opts));
    expect(r.status, r.out).toBe(64);
    expect(r.out).toContain(message);
    expect(r.out).not.toContain("type-aware lint OK");
  });

  it("an unparseable baseline fails", () => {
    const r = run(scratch({ report: { "src/a.ts": [] }, baseline: "{ nope" }));
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("type-aware lint OK");
  });

  it("a baseline with no `files` map fails rather than reading as empty", () => {
    const r = run(scratch({ report: { "src/a.ts": [] }, baseline: JSON.stringify({ "//": "oops" }) }));
    expect(r.status).toBe(64);
    expect(r.out).toContain("has no `files` map");
  });
});

describe("check-type-aware.mjs — --write-baseline", () => {
  it("records current findings sorted by file and rule, then the gate passes on them", () => {
    const root = scratch({
      report: { "src/z.ts": [MISUSED, FLOATING], "src/a.ts": [FLOATING, FLOATING] },
      baseline: null,
      exit: 1,
    });
    const w = run(root, ["--write-baseline"]);
    expect(w.status, w.out).toBe(0);
    expect(w.out).toContain("2 files, 4 violations");
    const written = readBaseline(root);
    expect(Object.keys(written.files)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(Object.keys(written.files["src/z.ts"])).toEqual(["no-floating-promises", "no-misused-promises"]);
    expect(written.files["src/a.ts"]).toEqual({ "no-floating-promises": 2 });
    expect(run(root).status).toBe(0);
  });

  it("does not write a baseline from a run it could not read", () => {
    const root = scratch({ report: "[]", baseline: null });
    const w = run(root, ["--write-baseline"]);
    expect(w.status).toBe(64);
    expect(() => readBaseline(root)).toThrow();
  });
});
