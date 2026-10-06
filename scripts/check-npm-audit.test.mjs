// WI-RA13A.1 — the npm advisory gate fails on a new advisory, on a stale acceptance, and on a scan it cannot read
/**
 * Runs the REAL `scripts/check-npm-audit.mjs` in a scratch tree in tmpdir with
 * a fake `pnpm` on PATH supplying the audit output. No network, no in-process
 * mocks: the gate's whole job is turning scanner output plus a baseline into
 * an exit code, so the exit code is what is asserted.
 *
 * Semantics pinned:
 *   - a moderate/high/critical advisory NOT in the baseline -> exit 1;
 *   - a baseline entry whose advisory is gone -> exit 1 (two-way);
 *   - a baseline entry with no reason -> exit 1;
 *   - every advisory accepted and current, or none at all -> exit 0;
 *   - `low` is reported but never blocks;
 *   - output the gate cannot read as an audit report -> non-zero. A scanner
 *     error must never read as "no vulnerabilities", including when the
 *     baseline is EMPTY (the case where "zero findings" used to pass).
 *
 * @coordinates-with scripts/check-npm-audit.mjs — the gate under test
 * @module scripts/check-npm-audit.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluate, parseAdvisories } from "./check-npm-audit.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

const advisory = (id, severity, module_name = "left-pad") => ({
  id: 1,
  github_advisory_id: id,
  module_name,
  severity,
  title: `${severity} problem in ${module_name}`,
  patched_versions: ">=9.9.9",
});

/** `pnpm audit --json` output carrying exactly these advisories. */
const auditJson = (...list) =>
  JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(list.map((a, i) => [String(1000 + i), a])),
    muted: [],
    metadata: { vulnerabilities: {} },
  });

const accept = (...ids) => ({
  accepted: Object.fromEntries(ids.map((id) => [id, { module: "left-pad", reason: "not shipped" }])),
});

/**
 * A scratch tree holding the real gate, a baseline, and a `pnpm` stub.
 *
 * `stdout` is what the stub prints; `exit` is its status (pnpm exits non-zero
 * when it FINDS advisories, so both statuses are normal).
 */
function scratch({ stdout, exit = 0, baseline = { accepted: {} }, stderr = "" }) {
  const root = mkdtempSync(path.join(tmpdir(), "npm-audit-"));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  cpSync(path.join(REPO, "scripts/check-npm-audit.mjs"), path.join(root, "scripts/check-npm-audit.mjs"));
  cpSync(path.join(REPO, "scripts/lib/isMainModule.mjs"), path.join(root, "scripts/lib/isMainModule.mjs"));
  writeFileSync(path.join(root, "scripts/npm-audit-baseline.json"), JSON.stringify(baseline));
  writeFileSync(path.join(root, "audit.out"), stdout);
  writeFileSync(path.join(root, "audit.err"), stderr);

  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const stub = path.join(bin, "pnpm");
  // The stub answers ONLY `pnpm audit --json`; anything else is a test bug.
  writeFileSync(
    stub,
    `#!/bin/bash\nif [ "$1" != "audit" ] || [ "$2" != "--json" ]; then echo "unexpected pnpm $*" >&2; exit 97; fi\n` +
      `cat "${root}/audit.out"\ncat "${root}/audit.err" >&2\nexit ${exit}\n`,
  );
  chmodSync(stub, 0o755);
  return { root, bin };
}

function run({ root, bin }, args = []) {
  return spawnSync(process.execPath, [path.join(root, "scripts/check-npm-audit.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
}

describe("check-npm-audit.mjs — the comparison, both directions", () => {
  it("exits 0 when the scan is clean and the baseline is empty", () => {
    const r = run(scratch({ stdout: auditJson() }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("0 advisories (none)");
    expect(r.stdout).toContain("every advisory is reviewed and still current");
  });

  it("exits 0 when every advisory is accepted and every acceptance is current", () => {
    const r = run(
      scratch({
        stdout: auditJson(advisory("GHSA-aaaa", "high"), advisory("GHSA-bbbb", "moderate")),
        exit: 1,
        baseline: accept("GHSA-aaaa", "GHSA-bbbb"),
      }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("2 advisories (1 high, 1 moderate)");
  });

  it.each(["moderate", "high", "critical"])("a NEW %s advisory fails and is named", (severity) => {
    const r = run(
      scratch({
        stdout: auditJson(advisory("GHSA-aaaa", "high"), advisory("GHSA-new1", severity, "evil-dep")),
        exit: 1,
        baseline: accept("GHSA-aaaa"),
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("1 advisory/advisories are not reviewed");
    expect(r.stderr).toContain(`${severity} evil-dep GHSA-new1`);
    // The accepted one must not be reported as unreviewed alongside it.
    expect(r.stderr).not.toContain("left-pad GHSA-aaaa");
  });

  it("a new LOW advisory is counted but does not block", () => {
    const r = run(scratch({ stdout: auditJson(advisory("GHSA-low1", "low")), exit: 1 }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("1 advisories (1 low)");
  });

  it("a baselined advisory that DISAPPEARED fails — an acceptance cannot outlive its risk", () => {
    const r = run(
      scratch({
        stdout: auditJson(advisory("GHSA-aaaa", "high")),
        exit: 1,
        baseline: accept("GHSA-aaaa", "GHSA-gone"),
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("1 baseline entry/entries no longer apply");
    expect(r.stderr).toContain("GHSA-gone");
    expect(r.stderr).not.toContain("are not reviewed");
  });

  it("an acceptance with a blank reason fails", () => {
    const r = run(
      scratch({
        stdout: auditJson(advisory("GHSA-aaaa", "high")),
        exit: 1,
        baseline: { accepted: { "GHSA-aaaa": { module: "left-pad", reason: "   " } } },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("have no reason");
    expect(r.stderr).toContain("GHSA-aaaa");
  });

  it("reports every class of problem in one run", () => {
    const r = run(
      scratch({
        stdout: auditJson(advisory("GHSA-new1", "critical")),
        exit: 1,
        baseline: { accepted: { "GHSA-gone": { module: "x", reason: "" } } },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("are not reviewed");
    expect(r.stderr).toContain("no longer apply");
    expect(r.stderr).toContain("have no reason");
  });

  it("an advisory without a GHSA id is keyed by its numeric id", () => {
    const noGhsa = { ...advisory("", "high"), id: 4242, github_advisory_id: undefined };
    const fail = run(scratch({ stdout: auditJson(noGhsa), exit: 1 }));
    expect(fail.status).toBe(1);
    expect(fail.stderr).toContain("left-pad 4242");
    const pass = run(scratch({ stdout: auditJson(noGhsa), exit: 1, baseline: accept("4242") }));
    expect(pass.status, pass.stderr).toBe(0);
  });

  it("--report lists findings and never fails, even with a new advisory", () => {
    const r = run(
      scratch({
        stdout: auditJson(advisory("GHSA-aaaa", "high"), advisory("GHSA-new1", "critical")),
        exit: 1,
        baseline: accept("GHSA-aaaa"),
      }),
      ["--report"],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("[accepted] high left-pad GHSA-aaaa");
    expect(r.stdout).toContain("[NEW] critical left-pad GHSA-new1");
  });
});

describe("check-npm-audit.mjs — an unreadable scan fails closed", () => {
  // Each of these used to parse as "zero advisories". With a non-empty baseline
  // that happened to trip the stale check; with an EMPTY one it exited 0, which
  // is the state the baseline is supposed to reach.
  it.each([
    ["truncated JSON", '{"advisories": {"1": {"sever'],
    ["an HTML error page", "<html><body>502 Bad Gateway</body></html>"],
    ["a pnpm error object", JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "410" } })],
    ["JSON with no advisories key", JSON.stringify({ metadata: {} })],
    ["advisories that is not an object", JSON.stringify({ advisories: "none" })],
    ["advisories that is an array", JSON.stringify({ advisories: [] })],
    ["a bare JSON null", "null"],
    ["an advisory that is not an object", JSON.stringify({ advisories: { 1: "high" } })],
    ["an advisory with no id", JSON.stringify({ advisories: { 1: { severity: "high" } } })],
    // Neither blocking nor reviewed: it would pass straight through.
    ["an unknown severity", auditJson(advisory("GHSA-odd1", "catastrophic"))],
    ["a missing severity", auditJson({ ...advisory("GHSA-odd2", "high"), severity: undefined })],
  ])("%s -> non-zero with an EMPTY baseline", (_label, stdout) => {
    const r = run(scratch({ stdout, exit: 1 }));
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).not.toBe(0);
    expect(r.stdout).not.toContain("every advisory is reviewed");
    expect(r.stderr).toContain("npm-audit: cannot read the scan output");
  });

  it("an unreadable scan fails even when the scanner itself exited 0", () => {
    const r = run(scratch({ stdout: "not json at all", exit: 0 }));
    expect(r.status).not.toBe(0);
  });

  it("--report does not turn an unreadable scan into a pass", () => {
    const r = run(scratch({ stdout: "not json at all", exit: 1 }), ["--report"]);
    expect(r.status).not.toBe(0);
  });

  it("a scanner that fails with NO output exits 64", () => {
    const r = run(scratch({ stdout: "", exit: 1, stderr: "ECONNREFUSED registry.npmjs.org\n" }));
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("the scan produced no output");
    expect(r.stderr).toContain("ECONNREFUSED");
  });

  it("a scanner that exits 0 with NO output is not a clean scan", () => {
    const r = run(scratch({ stdout: "", exit: 0 }));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("every advisory is reviewed");
  });

  it("an unparseable baseline file fails", () => {
    const s = scratch({ stdout: auditJson() });
    writeFileSync(path.join(s.root, "scripts/npm-audit-baseline.json"), "{ not json");
    const r = run(s);
    expect(r.status).not.toBe(0);
  });

  it("NDJSON output is still read: the advisories object arrives on its own line", () => {
    const lines =
      JSON.stringify({ progress: "resolving" }) +
      "\n" +
      auditJson(advisory("GHSA-new1", "high")) +
      "\n";
    const r = run(scratch({ stdout: lines, exit: 1 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("GHSA-new1");
  });
});

describe("check-npm-audit.mjs — pure halves", () => {
  it("parseAdvisories throws on a shape that is not an audit report", () => {
    expect(() => parseAdvisories("garbage")).toThrow();
    expect(() => parseAdvisories("{}")).toThrow();
    expect(parseAdvisories(auditJson())).toEqual([]);
  });

  it("evaluate ignores non-blocking severities but still counts them as seen", () => {
    const findings = [{ id: "GHSA-low1", severity: "low" }, { id: "GHSA-info", severity: "info" }];
    expect(evaluate(findings, { accepted: {} })).toEqual({ unlisted: [], stale: [], unjustified: [] });
    // A baselined low advisory that is still present is not stale.
    expect(evaluate(findings, accept("GHSA-low1")).stale).toEqual([]);
  });

  it("evaluate tolerates a baseline with no accepted map", () => {
    expect(evaluate([{ id: "GHSA-x", severity: "high" }], {}).unlisted).toHaveLength(1);
  });
});
