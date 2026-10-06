// WI-RA16.3 — the RustSec gate fails on an unreviewed finding of any kind, on an acceptance whose finding is gone, and on a scan it cannot read
/**
 * Runs the REAL `scripts/check-cargo-audit.mjs` in a scratch tree in tmpdir
 * with a fake `cargo` on PATH supplying the audit output. No network, no
 * in-process mocks: the gate turns scanner output plus an acceptance file into
 * an exit code, so the exit code is what is asserted.
 *
 * Semantics pinned:
 *   - a vulnerability OR a warning (unmaintained, unsound, yanked, any other
 *     kind) that is not accepted -> exit 1. Warnings are the point: bare
 *     `cargo audit` exits 0 over them;
 *   - an acceptance whose finding is gone -> exit 1 (two-way);
 *   - an acceptance with no reason, or naming another crate or kind -> exit 1;
 *   - every finding accepted and current, or none at all -> exit 0;
 *   - a yanked crate is keyed by crate AND version;
 *   - output the gate cannot read as an audit report -> non-zero, including
 *     when the acceptance file is EMPTY.
 *
 * The last block checks the committed acceptance file itself.
 *
 * @coordinates-with scripts/check-cargo-audit.mjs — the gate under test
 * @coordinates-with scripts/cargo-audit-baseline.json
 * @module scripts/check-cargo-audit.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { evaluate, parseFindings, UnreadableScanError } from "./check-cargo-audit.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

const pkg = (name, version) => ({ name, version, source: "registry+https://example.invalid/index" });

const vulnerability = (id, name = "left-pad", version = "1.0.0") => ({
  advisory: { id, package: name, title: `problem in ${name}` },
  versions: { patched: [">=9.9.9"], unaffected: [] },
  package: pkg(name, version),
});

const warning = (kind, id, name = "left-pad", version = "1.0.0") => ({
  kind,
  package: pkg(name, version),
  advisory: id ? { id, package: name, title: `${name} is ${kind}` } : null,
  affected: null,
  versions: id ? { patched: [], unaffected: [] } : null,
});

/** `cargo audit --json` output carrying these vulnerabilities and warnings. */
const auditJson = ({ vulnerabilities = [], warnings = {} } = {}) =>
  JSON.stringify({
    database: { "advisory-count": 1 },
    lockfile: { "dependency-count": 1 },
    settings: {},
    vulnerabilities: { found: vulnerabilities.length > 0, count: vulnerabilities.length, list: vulnerabilities },
    warnings,
  });

const accept = (...entries) => ({
  accepted: Object.fromEntries(
    entries.map(([id, kind, crate = "left-pad"]) => [id, { crate, kind, reason: "no fixed version is reachable" }]),
  ),
});

/**
 * A scratch tree holding the real gate, an acceptance file and a `cargo` stub.
 *
 * `stdout` is what the stub prints; `exit` is its status (cargo audit exits
 * non-zero when it FINDS a vulnerability, so both statuses are normal).
 */
function scratch({ stdout, exit = 0, baseline = { accepted: {} }, stderr = "" }) {
  const root = mkdtempSync(path.join(tmpdir(), "cargo-audit-"));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  cpSync(path.join(REPO, "scripts/check-cargo-audit.mjs"), path.join(root, "scripts/check-cargo-audit.mjs"));
  cpSync(path.join(REPO, "scripts/lib/isMainModule.mjs"), path.join(root, "scripts/lib/isMainModule.mjs"));
  const baselineText = typeof baseline === "string" ? baseline : JSON.stringify(baseline);
  writeFileSync(path.join(root, "scripts/cargo-audit-baseline.json"), baselineText);
  writeFileSync(path.join(root, "audit.out"), stdout);
  writeFileSync(path.join(root, "audit.err"), stderr);

  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const stub = path.join(bin, "cargo");
  // The stub answers ONLY the exact scan the gate runs; anything else is a
  // test bug, and in particular an `--ignore` flag creeping back in.
  writeFileSync(
    stub,
    `#!/bin/bash\nif [ "$*" != "audit --json --file src-tauri/Cargo.lock" ]; then echo "unexpected cargo $*" >&2; exit 97; fi\n` +
      `cat "${root}/audit.out"\ncat "${root}/audit.err" >&2\nexit ${exit}\n`,
  );
  chmodSync(stub, 0o755);
  return { root, bin };
}

function run({ root, bin }, args = []) {
  return spawnSync(process.execPath, [path.join(root, "scripts/check-cargo-audit.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
}

describe("check-cargo-audit.mjs — the comparison, both directions", () => {
  it("exits 0 when the scan is clean and nothing is accepted", () => {
    const r = run(scratch({ stdout: auditJson() }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("0 findings (none)");
    expect(r.stdout).toContain("every finding is reviewed and still current");
  });

  it("exits 0 when every finding is accepted and every acceptance is current", () => {
    const r = run(
      scratch({
        stdout: auditJson({
          vulnerabilities: [vulnerability("RUSTSEC-0000-0001")],
          warnings: {
            unmaintained: [warning("unmaintained", "RUSTSEC-0000-0002")],
            yanked: [warning("yanked", null, "left-pad", "1.0.0")],
          },
        }),
        exit: 1,
        baseline: accept(
          ["RUSTSEC-0000-0001", "vulnerability"],
          ["RUSTSEC-0000-0002", "unmaintained"],
          ["yanked:left-pad@1.0.0", "yanked"],
        ),
      }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("3 findings (1 vulnerability, 1 unmaintained, 1 yanked)");
  });

  it("a NEW vulnerability fails and is named with its patched range", () => {
    const r = run(scratch({ stdout: auditJson({ vulnerabilities: [vulnerability("RUSTSEC-0000-0009", "evil-dep", "2.0.0")] }), exit: 1 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("1 finding(s) are not reviewed");
    expect(r.stderr).toContain("vulnerability evil-dep 2.0.0 RUSTSEC-0000-0009");
    expect(r.stderr).toContain("patched: >=9.9.9");
  });

  // Bare `cargo audit` exits 0 for every one of these. The scanner stub exits
  // 0 here too, so a gate that trusted the scanner's status would pass.
  it.each(["unmaintained", "unsound", "notice", "some-future-kind"])(
    "a NEW %s warning fails although the scanner exited 0",
    (kind) => {
      const r = run(
        scratch({
          stdout: auditJson({ warnings: { [kind]: [warning(kind, "RUSTSEC-0000-0003", "old-dep")] } }),
          exit: 0,
          baseline: accept(["RUSTSEC-0000-0001", "unmaintained"]),
        }),
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${kind} old-dep 1.0.0 RUSTSEC-0000-0003`);
    },
  );

  it("a NEW yanked crate fails and is keyed by crate and version", () => {
    const r = run(scratch({ stdout: auditJson({ warnings: { yanked: [warning("yanked", null, "pulled", "0.3.1")] } }) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("yanked pulled 0.3.1 yanked:pulled@0.3.1");
  });

  it("accepting one yanked version does not accept another version of the same crate", () => {
    const r = run(
      scratch({
        stdout: auditJson({ warnings: { yanked: [warning("yanked", null, "pulled", "0.3.2")] } }),
        baseline: accept(["yanked:pulled@0.3.1", "yanked", "pulled"]),
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("yanked:pulled@0.3.2");
    expect(r.stderr).toContain("1 acceptance(s) no longer apply");
  });

  it("an acceptance whose finding DISAPPEARED fails — it cannot outlive its risk", () => {
    const r = run(
      scratch({
        stdout: auditJson({ warnings: { unsound: [warning("unsound", "RUSTSEC-0000-0004")] } }),
        baseline: accept(["RUSTSEC-0000-0004", "unsound"], ["RUSTSEC-0000-0005", "vulnerability"]),
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("1 acceptance(s) no longer apply");
    expect(r.stderr).toContain("RUSTSEC-0000-0005");
    expect(r.stderr).not.toContain("are not reviewed");
  });

  it("an acceptance with a blank or missing reason fails", () => {
    for (const reason of ["   ", undefined]) {
      const r = run(
        scratch({
          stdout: auditJson({ warnings: { unsound: [warning("unsound", "RUSTSEC-0000-0004")] } }),
          baseline: { accepted: { "RUSTSEC-0000-0004": { crate: "left-pad", kind: "unsound", reason } } },
        }),
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("have no reason");
      expect(r.stderr).toContain("RUSTSEC-0000-0004");
    }
  });

  it("an acceptance naming a different crate or kind than the finding fails", () => {
    const stdout = auditJson({ warnings: { unsound: [warning("unsound", "RUSTSEC-0000-0004", "real-dep")] } });
    const wrongCrate = run(scratch({ stdout, baseline: accept(["RUSTSEC-0000-0004", "unsound", "other-dep"]) }));
    expect(wrongCrate.status).toBe(1);
    expect(wrongCrate.stderr).toContain('accepted for crate "other-dep", reported against real-dep');
    const wrongKind = run(scratch({ stdout, baseline: accept(["RUSTSEC-0000-0004", "unmaintained", "real-dep"]) }));
    expect(wrongKind.status).toBe(1);
    expect(wrongKind.stderr).toContain('accepted as "unmaintained", reported as unsound');
  });

  it("reports every class of problem in one run", () => {
    const r = run(
      scratch({
        stdout: auditJson({ vulnerabilities: [vulnerability("RUSTSEC-0000-0009")] }),
        exit: 1,
        baseline: { accepted: { "RUSTSEC-0000-0005": { crate: "x", kind: "unsound", reason: "" } } },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("are not reviewed");
    expect(r.stderr).toContain("no longer apply");
    expect(r.stderr).toContain("have no reason");
  });

  it("one advisory reported against two versions of a crate is one finding", () => {
    const r = run(
      scratch({
        stdout: auditJson({
          warnings: {
            unsound: [
              warning("unsound", "RUSTSEC-0000-0004", "left-pad", "1.0.0"),
              warning("unsound", "RUSTSEC-0000-0004", "left-pad", "2.0.0"),
            ],
          },
        }),
        baseline: accept(["RUSTSEC-0000-0004", "unsound"]),
      }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("1 findings (1 unsound)");
  });

  it("--report lists findings and never fails, even with a new one", () => {
    const r = run(
      scratch({
        stdout: auditJson({
          vulnerabilities: [vulnerability("RUSTSEC-0000-0009")],
          warnings: { unsound: [warning("unsound", "RUSTSEC-0000-0004")] },
        }),
        exit: 1,
        baseline: accept(["RUSTSEC-0000-0004", "unsound"]),
      }),
      ["--report"],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("[accepted] unsound left-pad 1.0.0 RUSTSEC-0000-0004");
    expect(r.stdout).toContain("[NEW] vulnerability left-pad 1.0.0 RUSTSEC-0000-0009");
  });
});

describe("check-cargo-audit.mjs — an unreadable scan fails closed", () => {
  const noList = JSON.stringify({ vulnerabilities: { found: false, count: 0 }, warnings: {} });
  it.each([
    ["truncated JSON", '{"vulnerabilities": {"list": [{"advis'],
    ["a plain-text error", "error: couldn't fetch advisory database: network unreachable"],
    ["a bare JSON null", "null"],
    ["a JSON array", "[]"],
    ["JSON with no vulnerabilities key", JSON.stringify({ warnings: {} })],
    ["vulnerabilities with no list", noList],
    ["a list that is not an array", JSON.stringify({ vulnerabilities: { list: {} }, warnings: {} })],
    ["JSON with no warnings key", JSON.stringify({ vulnerabilities: { list: [] } })],
    ["warnings that is an array", JSON.stringify({ vulnerabilities: { list: [] }, warnings: [] })],
    ["a warning kind that is not a list", JSON.stringify({ vulnerabilities: { list: [] }, warnings: { unsound: "one" } })],
    ["a warning with no package", auditJson({ warnings: { unsound: [{ kind: "unsound", advisory: { id: "RUSTSEC-0000-0004" } }] } })],
    ["a warning with no crate name", auditJson({ warnings: { yanked: [{ kind: "yanked", package: { version: "1.0.0" } }] } })],
    ["a warning with no version", auditJson({ warnings: { yanked: [{ kind: "yanked", package: { name: "x" } }] } })],
    ["a vulnerability with no advisory id", auditJson({ vulnerabilities: [{ package: pkg("x", "1.0.0"), advisory: {} }] })],
  ])("%s -> non-zero with an EMPTY acceptance file", (_label, stdout) => {
    const r = run(scratch({ stdout, exit: 1 }));
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).not.toBe(0);
    expect(r.stdout).not.toContain("every finding is reviewed");
    expect(r.stderr).toContain("cargo-audit: cannot read the scan output");
  });

  it("an unreadable scan fails even when the scanner itself exited 0", () => {
    expect(run(scratch({ stdout: "not json at all", exit: 0 })).status).not.toBe(0);
  });

  it("--report does not turn an unreadable scan into a pass", () => {
    expect(run(scratch({ stdout: "not json at all", exit: 1 }), ["--report"]).status).not.toBe(0);
  });

  it("a scanner that fails with NO output exits 64 and shows why", () => {
    const r = run(scratch({ stdout: "", exit: 1, stderr: "error: no such command: `audit`\n" }));
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("the scan produced no output");
    expect(r.stderr).toContain("no such command");
  });

  it("a scanner that exits 0 with NO output is not a clean scan", () => {
    const r = run(scratch({ stdout: "", exit: 0 }));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("every finding is reviewed");
  });

  it.each([
    ["unparseable", "{ not json"],
    ["missing its `accepted` map", JSON.stringify({ entries: [] })],
    ["an array", "[]"],
  ])("an acceptance file that is %s fails", (_label, baseline) => {
    const r = run(scratch({ stdout: auditJson(), baseline }));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("every finding is reviewed");
  });
});

describe("check-cargo-audit.mjs — pure halves", () => {
  it("parseFindings keys an advisory by id and a yanked crate by crate and version", () => {
    const findings = parseFindings(
      auditJson({
        vulnerabilities: [vulnerability("RUSTSEC-0000-0009", "a", "1.2.3")],
        warnings: { yanked: [warning("yanked", null, "b", "0.1.0")] },
      }),
    );
    expect(findings).toEqual([
      { id: "RUSTSEC-0000-0009", kind: "vulnerability", crate: "a", version: "1.2.3", title: "problem in a", patched: ">=9.9.9" },
      { id: "yanked:b@0.1.0", kind: "yanked", crate: "b", version: "0.1.0", title: "", patched: "" },
    ]);
  });

  it("parseFindings throws UnreadableScanError, not a TypeError, on a foreign shape", () => {
    expect(() => parseFindings("{}")).toThrow(UnreadableScanError);
    expect(() => parseFindings("")).toThrow(UnreadableScanError);
  });

  it("evaluate returns nothing for an empty scan against an empty file", () => {
    expect(evaluate([], { accepted: {} })).toEqual({ unlisted: [], stale: [], unjustified: [], mismatched: [] });
  });
});

describe("the committed acceptance file and its wiring", () => {
  const file = JSON.parse(readFileSync(path.join(REPO, "scripts/cargo-audit-baseline.json"), "utf8"));
  const entries = Object.entries(file.accepted);

  it("gives every acceptance a crate, a kind and a reason that names a dependency path", () => {
    for (const [id, entry] of entries) {
      expect(typeof entry.crate, id).toBe("string");
      expect(typeof entry.kind, id).toBe("string");
      expect(entry.reason, id).toMatch(/\S+ > \S+/);
    }
  });

  it("keys a yanked acceptance by the crate and version it names", () => {
    for (const [id, entry] of entries.filter(([, e]) => e.kind === "yanked")) {
      expect(id).toMatch(new RegExp(`^yanked:${entry.crate}@\\d+\\.\\d+\\.\\d+`));
    }
  });

  const cargoAuditRuns = (workflow) =>
    Object.values(parse(readFileSync(path.join(REPO, ".github/workflows", workflow), "utf8")).jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => String(step.run ?? ""))
      .filter((command) => /cargo[- ]audit/.test(command));

  it.each(["ci.yml", "rust-scheduled.yml"])("%s runs the gate, and never bare `cargo audit`", (workflow) => {
    const runs = cargoAuditRuns(workflow);
    expect(runs).toEqual(["node scripts/check-cargo-audit.mjs"]);
  });

  it("no workflow carries an --ignore flag for an advisory", () => {
    const text = ["ci.yml", "rust-scheduled.yml"]
      .map((workflow) => readFileSync(path.join(REPO, ".github/workflows", workflow), "utf8"))
      .join("\n");
    expect(text).not.toMatch(/--ignore\s+RUSTSEC/);
  });

  it("the Rust path filter covers the gate and its acceptance file", () => {
    const ci = parse(readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8"));
    const filterStep = ci.jobs.changes.steps.find((step) => String(step.uses ?? "").startsWith("dorny/paths-filter@"));
    const rustPaths = parse(filterStep.with.filters).rust;
    expect(rustPaths).toContain("scripts/check-cargo-audit.mjs");
    expect(rustPaths).toContain("scripts/cargo-audit-baseline.json");
  });
});
