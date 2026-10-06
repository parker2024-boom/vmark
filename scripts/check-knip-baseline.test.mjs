// WI-RA13A.4 — the knip warn-tier ratchet fails on growth, on an unrecorded shrink, and on a report it cannot read
/**
 * Runs the REAL `scripts/check-knip-baseline.mjs` in a scratch tree with an
 * `npx` stub on PATH standing in for knip. The gate's job is turning knip's
 * JSON plus a committed baseline into an exit code, so that is what is pinned.
 *
 * The baseline is all zeros today, which makes one case matter more than the
 * rest: output that is JSON but is not a knip report must NOT count as "zero
 * findings", because zero is exactly what the baseline expects.
 *
 * @coordinates-with scripts/check-knip-baseline.mjs — the gate under test
 * @module scripts/check-knip-baseline.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const FAMILIES = ["exports", "nsExports", "types", "nsTypes", "duplicates", "enumMembers"];
const zeros = () => Object.fromEntries(FAMILIES.map((f) => [f, 0]));

/** A knip JSON report with `n` findings of each named family, in one file. */
const report = (counts = {}) =>
  JSON.stringify({
    issues: [
      {
        file: "src/a.ts",
        ...Object.fromEntries(
          Object.entries(counts).map(([family, n]) => [
            family,
            Array.from({ length: n }, (_, i) => ({ name: `${family}${i}` })),
          ]),
        ),
      },
    ],
  });

function scratch({ stdout, exit = 0, baseline = zeros() }) {
  const root = mkdtempSync(path.join(tmpdir(), "knip-baseline-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  cpSync(path.join(REPO, "scripts/check-knip-baseline.mjs"), path.join(root, "scripts/check-knip-baseline.mjs"));
  if (baseline !== null) {
    writeFileSync(
      path.join(root, "scripts/knip-baseline.json"),
      typeof baseline === "string" ? baseline : JSON.stringify(baseline),
    );
  }
  writeFileSync(path.join(root, "knip.out"), stdout);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const stub = path.join(bin, "npx");
  writeFileSync(
    stub,
    `#!/bin/bash\nif [ "$1" != "knip" ]; then echo "unexpected npx $*" >&2; exit 97; fi\ncat "${root}/knip.out"\nexit ${exit}\n`,
  );
  chmodSync(stub, 0o755);
  return { root, bin };
}

function run({ root, bin }) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-knip-baseline.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  return { ...r, out: r.stdout + r.stderr };
}

describe("check-knip-baseline.mjs — the ratchet, both directions", () => {
  it("exits 0 when every family matches a zero baseline", () => {
    const r = run(scratch({ stdout: JSON.stringify({ issues: [] }) }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Knip baseline held (0 warn-tier findings across 6 families)");
  });

  it("exits 0 when counts match a non-zero baseline, summed across files", () => {
    const stdout = JSON.stringify({
      issues: [
        { file: "a.ts", exports: [{ name: "x" }], types: [{ name: "T" }] },
        { file: "b.ts", exports: [{ name: "y" }, { name: "z" }] },
      ],
    });
    const r = run(scratch({ stdout, baseline: { ...zeros(), exports: 3, types: 1 } }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("4 warn-tier findings");
  });

  it.each(FAMILIES)("one new %s finding fails and names the family", (family) => {
    const r = run(scratch({ stdout: report({ [family]: 1 }) }));
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${family}: 1 findings, baseline 0 — new dead code.`);
  });

  it("a shrink that was not recorded fails, so a win cannot be reabsorbed", () => {
    const r = run(scratch({ stdout: report({ exports: 2 }), baseline: { ...zeros(), exports: 5 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("exports: only 2 findings but baseline says 5");
  });

  it("a family missing from the baseline fails rather than defaulting to anything", () => {
    const { enumMembers: _dropped, ...partial } = zeros();
    const r = run(scratch({ stdout: JSON.stringify({ issues: [] }), baseline: partial }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("enumMembers: no baseline entry");
  });

  it("a non-numeric baseline entry fails", () => {
    const r = run(scratch({ stdout: JSON.stringify({ issues: [] }), baseline: { ...zeros(), types: "0" } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("types: no baseline entry");
  });

  it("reports every drifting family in one run", () => {
    const r = run(scratch({ stdout: report({ exports: 1, duplicates: 2 }), baseline: { ...zeros(), types: 4 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("exports: 1 findings");
    expect(r.out).toContain("duplicates: 2 findings");
    expect(r.out).toContain("types: only 0 findings but baseline says 4");
  });

  it("error-tier families are not this gate's business", () => {
    const stdout = JSON.stringify({ issues: [{ file: "a.ts", files: [{ name: "a.ts" }], dependencies: [{ name: "x" }] }] });
    const r = run(scratch({ stdout, exit: 1 }));
    expect(r.status, r.out).toBe(0);
  });

  it("still reads the report when knip exits non-zero for an error-tier rule", () => {
    const r = run(scratch({ stdout: report({ exports: 1 }), exit: 1 }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("exports: 1 findings");
  });

  it("skips npm warning lines printed before the JSON", () => {
    const r = run(scratch({ stdout: `npm warn Unknown env config "x"\n${report({ types: 1 })}` }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("types: 1 findings");
  });
});

describe("check-knip-baseline.mjs — an unreadable report never counts as zero findings", () => {
  it.each([
    ["no output, exit 0", "", 0],
    ["no output, exit 1", "", 1],
    ["no JSON object at all", "knip: command not found", 127],
    ["truncated JSON", '{"issues":[{"file":"a.ts","exports":[', 0],
    ["JSON with no issues array", JSON.stringify({ error: "config invalid" }), 1],
    ["issues that is not an array", JSON.stringify({ issues: { exports: 0 } }), 0],
    ["an issue that is not an object", JSON.stringify({ issues: ["src/a.ts"] }), 0],
    ["a warn family that is not an array", JSON.stringify({ issues: [{ file: "a.ts", exports: 3 }] }), 0],
  ])("%s -> exit 1 against an all-zero baseline", (_label, stdout, exit) => {
    const r = run(scratch({ stdout, exit }));
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toContain("Knip baseline held");
  });

  it("a missing baseline file fails", () => {
    const r = run(scratch({ stdout: JSON.stringify({ issues: [] }), baseline: null }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("Cannot read");
  });

  it("an unparseable baseline file fails", () => {
    const r = run(scratch({ stdout: JSON.stringify({ issues: [] }), baseline: "{ nope" }));
    expect(r.status).toBe(1);
  });
});
