// WI-RA16.4 — the Rust coverage floor lives in a ratcheted baseline, is compared both ways, and the weekly job that measures it is a watched liveness gate
/**
 * Runs the REAL `scripts/check-rust-coverage.mjs` in a scratch tree against
 * fixture llvm-cov summaries and asserts exit codes, then pins the wiring of
 * `.github/workflows/rust-coverage.yml`.
 *
 * Semantics pinned:
 *   - uncovered lines above the baseline ceiling -> exit 1 (coverage fell);
 *   - uncovered lines further below the ceiling than the allowed slack ->
 *     exit 1 (the floor went stale; lower the ceiling);
 *   - inside the band, including both edges -> exit 0;
 *   - a summary the script cannot read, or one that measured zero lines ->
 *     exit 64. "Nothing was measured" must never read as "nothing regressed";
 *   - a baseline that is unreadable or out of range -> exit 64.
 *
 * The last two blocks read the real workflows: the floor is not restated in
 * YAML, the job runs where the baseline was measured, and every workflow that
 * declares a rolling issue as its failure path has a job that opens one.
 *
 * @coordinates-with scripts/check-rust-coverage.mjs — the gate under test
 * @coordinates-with scripts/rust-coverage-baseline.json
 * @coordinates-with .github/workflows/rust-coverage.yml
 * @module scripts/check-rust-coverage.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { MANIFEST } from "./baselineRatchetManifest.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

/** An llvm-cov `--json --summary-only` export measuring these line counts. */
const summary = (covered, count) =>
  JSON.stringify({
    type: "llvm.coverage.json.export",
    version: "3.1.0",
    data: [{ totals: { lines: { count, covered, percent: count ? (covered / count) * 100 : 0 } } }],
  });

const baselineOf = (maxUncoveredLinePercent, maxSlackPercent = 4) => ({
  maxUncoveredLinePercent,
  maxSlackPercent,
  measured: { linePercent: 100 - maxUncoveredLinePercent, runner: "macos-latest" },
});

function scratch({ summaryText, baseline = baselineOf(20) }) {
  const root = mkdtempSync(path.join(tmpdir(), "rust-coverage-"));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  cpSync(path.join(REPO, "scripts/check-rust-coverage.mjs"), path.join(root, "scripts/check-rust-coverage.mjs"));
  cpSync(path.join(REPO, "scripts/lib/isMainModule.mjs"), path.join(root, "scripts/lib/isMainModule.mjs"));
  writeFileSync(
    path.join(root, "scripts/rust-coverage-baseline.json"),
    typeof baseline === "string" ? baseline : JSON.stringify(baseline),
  );
  if (summaryText !== undefined) writeFileSync(path.join(root, "summary.json"), summaryText);
  return root;
}

function run(root, args = ["summary.json"]) {
  return spawnSync(process.execPath, [path.join(root, "scripts/check-rust-coverage.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("check-rust-coverage.mjs — the band", () => {
  // Ceiling 20% uncovered (floor 80% covered), slack 4: the band is 80%..84%.
  it("passes inside the band and reports the measurement", () => {
    const r = run(scratch({ summaryText: summary(820, 1000) }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("82.00% of 1000 lines covered");
    expect(r.stdout).toContain("floor 80.00%");
  });

  it("passes exactly on the floor and exactly at the top of the band", () => {
    expect(run(scratch({ summaryText: summary(800, 1000) })).status).toBe(0);
    expect(run(scratch({ summaryText: summary(840, 1000) })).status).toBe(0);
  });

  it("fails when coverage falls below the floor, naming both numbers", () => {
    const r = run(scratch({ summaryText: summary(799, 1000) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("79.90%");
    expect(r.stderr).toContain("below the floor of 80.00%");
  });

  it("fails when coverage has risen past the slack, and says what to lower the ceiling to", () => {
    const r = run(scratch({ summaryText: summary(900, 1000) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the floor is stale");
    // Measured 10% uncovered; half the slack is kept as headroom.
    expect(r.stderr).toContain('"maxUncoveredLinePercent": 12');
  });

  it("computes the percentage from the counts, not from the reported percent", () => {
    const lying = JSON.stringify({ data: [{ totals: { lines: { count: 1000, covered: 100, percent: 99 } } }] });
    expect(run(scratch({ summaryText: lying })).status).toBe(1);
  });

  it("handles a fully covered and a fully uncovered crate", () => {
    expect(run(scratch({ summaryText: summary(1000, 1000), baseline: baselineOf(2) })).status).toBe(0);
    expect(run(scratch({ summaryText: summary(0, 1000) })).status).toBe(1);
  });
});

describe("check-rust-coverage.mjs — fails closed", () => {
  it.each([
    ["truncated JSON", '{"data": [{"totals": {"lin'],
    ["a plain-text error", "error: no profile data found"],
    ["a bare JSON null", "null"],
    ["no data array", JSON.stringify({ type: "llvm.coverage.json.export" })],
    ["an empty data array", JSON.stringify({ data: [] })],
    ["no line totals", JSON.stringify({ data: [{ totals: { functions: { count: 1, covered: 1 } } }] })],
    ["counts that are not numbers", JSON.stringify({ data: [{ totals: { lines: { count: "1000", covered: "900" } } }] })],
    ["more covered than counted", summary(1001, 1000)],
    ["a negative count", summary(-1, 1000)],
    // Zero lines is what a run that instrumented nothing reports.
    ["zero lines measured", summary(0, 0)],
  ])("%s -> exit 64", (_label, summaryText) => {
    const r = run(scratch({ summaryText }));
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(64);
    expect(r.stdout).not.toContain("lines covered");
  });

  it("a missing summary file, or no argument, exits 64", () => {
    expect(run(scratch({})).status).toBe(64);
    expect(run(scratch({ summaryText: summary(820, 1000) }), []).status).toBe(64);
  });

  it.each([
    ["unparseable", "{ not json"],
    ["missing the ceiling", JSON.stringify({ maxSlackPercent: 4 })],
    ["missing the slack", JSON.stringify({ maxUncoveredLinePercent: 20 })],
    ["a ceiling above 100", JSON.stringify(baselineOf(101))],
    ["a negative ceiling", JSON.stringify(baselineOf(-1))],
    ["a zero slack", JSON.stringify(baselineOf(20, 0))],
    ["a string ceiling", JSON.stringify({ maxUncoveredLinePercent: "20", maxSlackPercent: 4 })],
  ])("a baseline that is %s exits 64", (_label, baseline) => {
    expect(run(scratch({ summaryText: summary(820, 1000), baseline })).status).toBe(64);
  });
});

describe("the committed baseline and the workflow that reads it", () => {
  const baseline = JSON.parse(readFileSync(path.join(REPO, "scripts/rust-coverage-baseline.json"), "utf8"));
  const text = readFileSync(path.join(REPO, ".github/workflows/rust-coverage.yml"), "utf8");
  const workflow = parse(text);
  const job = workflow.jobs.coverage;
  const runs = job.steps.map((step) => String(step.run ?? "")).join("\n");

  it("records a floor that is a measurement, not a round number someone chose", () => {
    const floor = 100 - baseline.maxUncoveredLinePercent;
    expect(baseline.measured.linePercent).toBeGreaterThan(0);
    // The floor sits below what was measured, by no more than the slack the
    // gate itself tolerates — otherwise the committed file fails its own gate.
    expect(floor).toBeLessThanOrEqual(baseline.measured.linePercent);
    expect(baseline.measured.linePercent - floor).toBeLessThanOrEqual(baseline.maxSlackPercent);
  });

  it("is ratcheted: both numbers are registered so neither can be raised", () => {
    const entry = MANIFEST.entries.find((e) => e.path === "scripts/rust-coverage-baseline.json");
    expect(entry, "scripts/rust-coverage-baseline.json is not in the ratchet manifest").toBeDefined();
    expect(entry.checks).toEqual([
      { mode: "scalar", at: "maxUncoveredLinePercent" },
      { mode: "scalar", at: "maxSlackPercent" },
    ]);
  });

  it("the workflow does not restate the floor", () => {
    expect(text).not.toMatch(/--fail-under-lines/);
    expect(runs).toContain("scripts/check-rust-coverage.mjs");
  });

  it("the workflow measures on the runner the baseline was measured on", () => {
    expect(job["runs-on"]).toBe(baseline.measured.runner);
  });

  it("the workflow is a declared liveness gate", () => {
    const r = spawnSync(process.execPath, [path.join(REPO, "scripts/check-gate-liveness.mjs"), "--list"], {
      encoding: "utf8",
      cwd: REPO,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^rust-coverage\.yml\tcadence=8d\ton-failure=rolling-issue$/m);
  });
});

describe("a declared rolling issue is a job, not a comment", () => {
  const dir = path.join(REPO, ".github/workflows");
  const declaring = readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) => /^\s*#\s*on-failure:\s*rolling-issue\s*$/m.test(readFileSync(path.join(dir, file), "utf8")));

  it("finds the workflows that declare one", () => {
    expect(declaring).toContain("rust-coverage.yml");
    expect(declaring.length).toBeGreaterThan(4);
  });

  it.each(declaring)("%s has a job that can write issues and opens one", (file) => {
    const { jobs } = parse(readFileSync(path.join(dir, file), "utf8"));
    const reporters = Object.values(jobs).filter(
      (job) =>
        job.permissions?.issues === "write" &&
        (job.steps ?? []).some((step) => /gh issue (create|comment|edit)/.test(String(step.run ?? ""))),
    );
    expect(reporters.length, `${file} declares on-failure: rolling-issue but no job opens an issue`).toBeGreaterThan(0);
  });
});
