// WI-RA16.5 — every e2e journey runs on at least one leg of the weekly workflow, and no hand-kept list decides which
/**
 * `tier0-e2e.yml` used to name nine journeys in a shell loop on one Linux
 * runner. Thirty-eight existed. Sixteen were simply not in the list, and the
 * thirteen that declare `platforms: ["darwin"]` could not have run there even
 * if they had been — the runner reports those as not applicable and exits 0.
 * A journey nobody schedules is a test that never runs, and adding a journey
 * file changed nothing about what CI executed.
 *
 * So the workflow now runs the WHOLE suite on each leg of an OS matrix, and
 * this file pins the two properties that make that hold:
 *   - no `--only` in the workflow, so there is no list to fall out of;
 *   - every journey can run on at least one leg, so a journey restricted to a
 *     platform the matrix lacks fails here instead of being skipped forever.
 *
 * @coordinates-with .github/workflows/tier0-e2e.yml
 * @coordinates-with e2e/run-journeys.mjs — applies each journey's `platforms`
 * @module scripts/check-e2e-schedule.test
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const REPO = path.resolve(import.meta.dirname, "..");
const JOURNEYS_DIR = path.join(REPO, "e2e/journeys");

/** GitHub runner label -> the `process.platform` a journey sees on it. */
const PLATFORM_OF_RUNNER = {
  "ubuntu-latest": "linux",
  "macos-latest": "darwin",
  "windows-latest": "win32",
};

const workflow = parse(readFileSync(path.join(REPO, ".github/workflows/tier0-e2e.yml"), "utf8"));
const job = workflow.jobs.journeys;
const legs = job.strategy?.matrix?.os ?? [];
const legPlatforms = legs.map((runner) => PLATFORM_OF_RUNNER[runner]);
const steps = job.steps ?? [];

const journeyFiles = readdirSync(JOURNEYS_DIR)
  .filter((file) => file.endsWith(".mjs"))
  .sort();
const journeys = await Promise.all(
  journeyFiles.map(async (file) => {
    const module = await import(pathToFileURL(path.join(JOURNEYS_DIR, file)).href);
    return { file, name: module.default.name, platforms: module.default.platforms ?? null };
  }),
);

describe("the weekly e2e workflow runs on every platform a journey needs", () => {
  it("has a Linux leg and a macOS leg, and one failing does not cancel the other", () => {
    expect(legs).toContain("ubuntu-latest");
    expect(legs).toContain("macos-latest");
    expect(job["runs-on"]).toBe("${{ matrix.os }}");
    expect(job.strategy["fail-fast"]).toBe(false);
  });

  it("knows the platform of every leg", () => {
    expect(legPlatforms).not.toContain(undefined);
  });

  it("reads the journeys it is checking", () => {
    expect(journeys.length).toBeGreaterThan(30);
    expect(journeys.every((journey) => typeof journey.name === "string" && journey.name)).toBe(true);
    // The suite has both kinds; if either count is zero the census is not
    // seeing `platforms`, and the next assertion would pass for no reason.
    expect(journeys.some((journey) => journey.platforms === null)).toBe(true);
    expect(journeys.some((journey) => Array.isArray(journey.platforms))).toBe(true);
  });

  it.each(journeys)("$file can run on at least one leg", ({ platforms }) => {
    const runsOn = platforms === null ? legPlatforms : legPlatforms.filter((leg) => platforms.includes(leg));
    expect(runsOn.length, `restricted to ${JSON.stringify(platforms)}, legs are ${legPlatforms}`).toBeGreaterThan(0);
  });
});

describe("the workflow runs the whole suite, not a list", () => {
  const journeyRuns = steps.map((step) => String(step.run ?? "")).filter((run) => run.includes("e2e/run-journeys.mjs"));

  it("invokes the runner exactly once, with no --only filter", () => {
    expect(journeyRuns).toHaveLength(1);
    expect(journeyRuns[0]).not.toContain("--only");
  });

  it("names no journey anywhere in a step", () => {
    const allRuns = steps.map((step) => String(step.run ?? "")).join("\n");
    const named = journeys.map((journey) => journey.name).filter((name) => allRuns.includes(name));
    expect(named).toEqual([]);
  });
});

describe("the matrix legs do not trip over each other", () => {
  it("gives each leg its own artifact name", () => {
    const uploads = steps.filter((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) expect(upload.with.name).toContain("${{ matrix.os }}");
  });

  it("installs and uses Xvfb only on Linux", () => {
    const xvfbSteps = steps.filter((step) => /apt-get[^\n]*\n?[^\n]*xvfb|install -y xvfb/.test(String(step.run ?? "")));
    expect(xvfbSteps.length).toBeGreaterThan(0);
    for (const step of xvfbSteps) expect(String(step.if ?? "")).toContain("runner.os == 'Linux'");
    const launch = steps.find((step) => String(step.run ?? "").includes("pnpm tauri:dev"));
    expect(launch, "no step launches the debug app").toBeDefined();
    // One launch line under Xvfb, one without: the macOS runner has a display.
    expect(launch.run).toMatch(/RUNNER_OS[^\n]*Linux/);
    expect(launch.run.match(/pnpm tauri:dev/g)).toHaveLength(2);
    expect(launch.run.match(/xvfb-run/g)).toHaveLength(1);
  });

  it("keys the build cache by runner OS", () => {
    const cache = steps.find((step) => String(step.uses ?? "").startsWith("actions/cache@"));
    expect(cache.with.key).toContain("${{ runner.os }}");
  });
});
