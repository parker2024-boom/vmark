// @vitest-environment node
/**
 * WI-3.1 — pathological-input freeze guards, in a TERMINABLE child process.
 *
 * Why a child: a synchronous parser hang blocks the event loop, so a vitest
 * timeout cannot interrupt it — the suite would sit until the CI job dies.
 * And in-process `performance.now()` assertions are CI-variance flakes
 * (`../performance.test.ts` keeps its wall-clock checks opt-in for exactly
 * that reason). So the ONLY hard assertion here is liveness under a generous
 * wall ceiling, enforced by killing the child from outside; per-case timings
 * are reported, not asserted.
 *
 * The self-test proves the enforcement is real: a deliberate busy-loop probe
 * (HANG_PROBE=1) must come back KILLED with the culprit named — a harness
 * whose kill path silently broke would otherwise report green forever.
 *
 * @coordinates-with runCases.ts — the child entry (tsx)
 * @coordinates-with pathologicalCases.ts — the case generators
 * @module utils/markdownPipeline/__tests__/pathological/pathological.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathologicalCases, pathologicalScale } from "./pathologicalCases";
import { MAX_NESTING_DEPTH } from "../../nestingDepth";
import { LIVENESS_TIMEOUT_MS } from "../../../../../vitest.shared";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const ENTRY = join(here, "runCases.ts");

/** Generous: every class together takes well under this on any dev machine
 *  or CI runner; a HANG is minutes-to-forever, so the gap is unambiguous.
 *
 *  This is a LIVENESS bound, not a performance assertion — per-case timings are
 *  reported, never asserted (see the header). It was 60s, which the gap made
 *  look unambiguous until the machine was saturated: the child pays Node + tsx
 *  startup before it parses anything, and with three suites competing for cores
 *  a perfectly healthy run hit 60023ms and was killed as a "hang". Raising the
 *  bound cannot mask a real hang — that is unbounded, and the child is still
 *  killed and its culprit named — it only stops a busy machine from forging
 *  one.
 *
 *  Then 180s did it again: on 2026-09-06 a healthy run was killed at 180048ms
 *  on a box at load average 105. Two nudges is a pattern, not bad luck — each
 *  value was picked by measuring healthy runs and adding headroom, which is
 *  what makes a liveness bound behave like a performance assertion. So it uses
 *  the SHARED bound now, set from what is unambiguously a hang rather than
 *  from how long healthy work takes; the whole file runs in ~33s alone. */
const WALL_CEILING_MS = LIVENESS_TIMEOUT_MS;

/** Kill window for the self-test probe.
 *
 *  Must cover Node + tsx startup AND the probe announcing itself, because the
 *  assertion is that the culprit is NAMEABLE. At 3s under load the child was
 *  killed before it printed `starting`, so the harness looked broken when it
 *  was working perfectly. */
const HANG_PROBE_WINDOW_MS = 20_000;

interface CaseReport {
  name?: string;
  starting?: boolean;
  parseMs?: number;
  serializeMs?: number;
  refusedMs?: number;
  refusedDepth?: number;
  done?: boolean;
}

/** Spawn `node --import tsx` DIRECTLY — never `node_modules/.bin/tsx`.
 *
 *  The tsx CLI is a launcher: it spawns the real runner as its own child and
 *  relays SIGINT/SIGTERM to it. SIGKILL is uncatchable, so the relay never
 *  runs — `spawnSync`'s timeout kills the launcher and REPARENTS the runner to
 *  PID 1, where it spins forever. The self-test's deliberate busy loop made
 *  that leak unconditional: every run of this file abandoned a process pegging
 *  a full core, and four of them once cost ~3.5 cores for 20 hours.
 *
 *  SIGTERM is NOT the fix: tsx would then exit normally with 143, so
 *  `res.signal` becomes null and the hang detector below silently stops
 *  detecting hangs. Removing the launcher keeps SIGKILL honest — the direct
 *  child IS the runner, so killing it kills the code under test. */
/** A token on THIS run's child command lines, so the leak check below finds
 *  only runners this file started. Matching on `ENTRY` alone also matched a
 *  concurrent run of this same file (a full-suite run beside a focused one)
 *  and reported its healthy, still-working child as a leak. The child ignores
 *  its argv; a reparented runner keeps the token, so a real leak still shows. */
const RUN_TAG = `pathological-run-${randomUUID()}`;

function runChild(env: Record<string, string>, timeoutMs: number) {
  const res = spawnSync(process.execPath, ["--import", "tsx", ENTRY, RUN_TAG], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { ...process.env, ...env },
  });
  const lines = (res.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as CaseReport);
  return { res, lines };
}

/** PIDs still running this run's child entry. `pgrep -f` matches the whole
 *  command line, so it finds a runner abandoned at ANY depth — which is the
 *  only way to observe the leak from in here. */
function survivingRunners(): string[] {
  const res = spawnSync("pgrep", ["-f", RUN_TAG], { encoding: "utf8" });
  return (res.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Poll until the kill is reaped, or give up after `attempts` checks spaced a
 *  quarter second apart. A leaked runner NEVER clears, so a real regression
 *  cannot buy a pass by polling longer. Bounded by a count of checks, not by
 *  reading the clock: `spawnSync` has already reaped the direct child, so a
 *  healthy run is clear on the first check. */
function waitForNoRunners(attempts: number): string[] {
  let alive = survivingRunners();
  for (let i = 1; i < attempts && alive.length > 0; i += 1) {
    spawnSync("sleep", ["0.25"]);
    alive = survivingRunners();
  }
  return alive;
}

describe("pathological inputs (killable child process)", () => {
  it(`every pathological class parses and serializes within the wall ceiling (scale ${pathologicalScale()})`, () => {
    const { res, lines } = runChild({}, WALL_CEILING_MS);

    const started = lines.filter((l) => l.starting && l.name).map((l) => l.name);
    const parsed = lines.filter((l) => l.parseMs !== undefined).map((l) => l.name);
    const refused = lines.filter((l) => l.refusedMs !== undefined).map((l) => l.name);
    const finished = new Set([...parsed, ...refused]);
    const lastStarted = started.at(-1);

    expect(
      res.signal,
      `child was killed — the class that hung: ${String(lastStarted)} ` +
        `(finished: ${[...finished].join(", ") || "none"})\nstderr: ${res.stderr}`,
    ).toBeNull();
    // The ceiling can also fire after the child EXITED, when a descendant still
    // holds its pipes: then `signal` is null and `status` is the child's own,
    // and only `error` (ETIMEDOUT) says the run blew the ceiling.
    expect(res.error, `the wall ceiling fired\nstderr: ${res.stderr}`).toBeUndefined();
    expect(res.status, `child failed\nstderr: ${res.stderr}`).toBe(0);
    expect(lines.some((l) => l.done)).toBe(true);

    // Every class must come back — parsed, or refused as too deeply nested.
    // Which of the two is decided by the case's DECLARED container depth at
    // the scale the child ran, so a refusal nobody expected fails here instead
    // of passing as "finished". The soak's scale 8 refuses the two container
    // classes; counting only parsed classes made that a failure (#1407).
    const cases = pathologicalCases(pathologicalScale());
    const deep = (c: (typeof cases)[number]) => c.containerDepth > MAX_NESTING_DEPTH;
    expect([...refused].sort()).toEqual(cases.filter(deep).map((c) => c.name).sort());
    expect([...parsed].sort()).toEqual(cases.filter((c) => !deep(c)).map((c) => c.name).sort());
    expect(finished.size).toBe(cases.length);
  }, WALL_CEILING_MS + 30_000);

  it("SELF-TEST: a deliberate busy loop is killed and reported, not hung", () => {
    const { res, lines } = runChild({ HANG_PROBE: "1" }, HANG_PROBE_WINDOW_MS);
    expect(res.signal).toBe("SIGKILL");
    expect((res.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT"); // killed by the window, nothing else
    // The probe announced itself before hanging — the culprit is nameable.
    expect(lines.some((l) => l.name === "hang-probe" && l.starting)).toBe(true);
    expect(lines.some((l) => l.done)).toBe(false);

    // REGRESSION GUARD: the kill must reach the code under test, not just its
    // launcher. Reintroduce a wrapper between us and the runner (see
    // runChild) and this probe silently abandons a core-pegging process on
    // every run — while every assertion above still passes.
    if (process.platform !== "win32") {
      expect(
        waitForNoRunners(20),
        "the killed probe left a process running the child entry: it was " +
          "reparented to PID 1 and is now spinning on a core forever",
      ).toEqual([]);
    }
  });
});
