// WI-RA28.1 — the full-repo audit plan's phase gate checks every phase mechanically, in both directions.
/**
 * Runs the REAL `scripts/check-repo-audit-phase.sh` as a subprocess against
 * fixture git repositories (house pattern of the other phase-checker
 * self-tests: real script, real git, real vitest file list, no in-process
 * mocks). Each fixture carries its own plan at the real plan's path and its
 * own copy of `scripts/check-wi-linkage.sh`, the tree's linkage gate.
 *
 * Pinned, both directions:
 *   - a phase whose work items are linked and pinned by collected tests that
 *     declare cases exits 0 — by test header, by a tagged commit's test, or
 *     by an honest `[no-test: <reason>]` mark;
 *   - near misses stay red: a work item linked only by PROSE, a test file no
 *     vitest tier collects, a test file that declares no case, a Rust test
 *     nothing mounts, a no-test mark a test contradicts, an empty mark, a
 *     work item under no phase heading, an unreadable plan;
 *   - `all` agrees with the phase table in both directions: a phase in the
 *     plan and not in the table fails, a phase in the table and not in the
 *     plan fails, and a lane the table does not list fails;
 *   - a bad invocation exits 64.
 *
 * @coordinates-with scripts/check-repo-audit-phase.sh — the checker under test
 * @coordinates-with scripts/repo-audit-evidence.mjs — the evidence it gathers
 * @coordinates-with scripts/check-wi-linkage.sh — copied into each fixture
 * @module scripts/check-repo-audit-phase.test
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-repo-audit-phase.sh");
const PLAN = ".claude/tdd-guardian/plan-20261002-full-repo-audit-fixes.md";
const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const GIT = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
const git = (root, ...args) => execFileSync("git", [...GIT, ...args], { cwd: root, encoding: "utf8" });
function write(root, rel, body) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
}

/**
 * A repository whose `main` holds the plan and the linkage gate, with a
 * feature branch on top: `commits` is `[{ message, files: { rel: body } }]`.
 */
function repo(plan, commits = []) {
  const root = mkdtempSync(path.join(tmpdir(), "repo-audit-phase-"));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(path.join(REPO, "scripts", "check-wi-linkage.sh"), path.join(root, "scripts", "check-wi-linkage.sh"));
  if (plan !== null) write(root, PLAN, plan);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "feature");
  for (const c of commits) {
    for (const [rel, body] of Object.entries(c.files ?? {})) {
      if (body === null) rmSync(path.join(root, rel));
      else write(root, rel, body);
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "--allow-empty", "-m", c.message);
  }
  return root;
}

// Bounded: a hung probe server must fail the case, not the tier.
function run(root, ...args) {
  const r = spawnSync("bash", [SCRIPT, ...args, `--root=${root}`], { encoding: "utf8", cwd: REPO, timeout: 240_000, killSignal: "SIGKILL" });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const phasePlan = (id, ...wis) => `# Plan\n\n### Wave 9\n\n#### Phase ${id} — fixture\n${wis.map((w) => `- **${w}**\n`).join("")}`;
const TEST = (id) => `// ${id} — fixture test\nimport { it } from "vitest";\nit("pins", () => {});\n`;
const NO_CASE = (id) => `// ${id} — fixture test\n// it("planned", () => {});\n`;

describe("one phase — green", () => {
  it("passes when the work item is linked and a collected test names it in its header", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback"), [
      { message: "fix(nav): roll back the tab (WI-RA27.1)", files: { "src/nav/rollback.test.ts": TEST("WI-RA27.1") } },
    ]), "RA27");
    expect(r.out).toContain("✓ WI-RA27.* linked (1 work items)");
    expect(r.out).toContain("✓ WI-RA27.1 pinned by 1 test file(s)");
    expect(r.out).toContain("✓ src/nav/rollback.test.ts (WI-RA27.1) (has cases)");
    expect(r.status, r.out).toBe(0);
  });

  it("takes a test a tagged commit added as evidence, header or not", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback"), [
      { message: "fix(nav): roll back the tab (WI-RA27.1)", files: { "src/nav/rollback.test.ts": 'import { it } from "vitest";\nit("pins", () => {});\n' } },
    ]), "RA27");
    expect(r.out).toContain("✓ WI-RA27.1 pinned by 1 test file(s)");
    expect(r.status, r.out).toBe(0);
  });

  it("gates each lane of a split phase on its own namespace", () => {
    const r = run(repo(phasePlan("RA1", "WI-RA1A.1 — writes", "WI-RA1B.1 — removal"), [
      { message: "fix: a (WI-RA1A.1)", files: { "src/a.test.ts": TEST("WI-RA1A.1") } },
      { message: "fix: b (WI-RA1B.1)", files: { "src/b.test.ts": TEST("WI-RA1B.1") } },
    ]), "RA1");
    expect(r.out).toContain("✓ WI-RA1A.* linked");
    expect(r.out).toContain("✓ WI-RA1B.* linked");
    expect(r.status, r.out).toBe(0);
  });

  it("accepts an honest no-test mark", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — wording [no-test: docs only]"), [
      { message: "docs: reword (WI-RA27.1)", files: { "README.md": "words\n" } },
    ]), "RA27");
    expect(r.out).toContain("✓ WI-RA27.1 needs no test (plan: docs only)");
    expect(r.status, r.out).toBe(0);
  });

  it("finds a Rust test cargo compiles, platform-gated or not", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rust"), [
      {
        message: "fix(rust): x (WI-RA27.1)",
        files: {
          "src-tauri/src/lib.rs": "mod foo;\n",
          "src-tauri/src/foo.rs": '#[cfg(all(test, unix))]\n#[path = "foo.test.rs"]\nmod tests;\n',
          "src-tauri/src/foo.test.rs": "// WI-RA27.1 — fixture\n#[test]\nfn pins() {}\n",
        },
      },
    ]), "RA27");
    expect(r.out).toContain("✓ src-tauri/src/foo.test.rs (WI-RA27.1) (included from foo.rs)");
    expect(r.status, r.out).toBe(0);
  });
});

describe("one phase — near misses stay red", () => {
  it("a work item linked only by prose is not linked", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback"), [
      { message: "fix(nav): this closes WI-RA27.1", files: { "src/nav/rollback.test.ts": 'import { it } from "vitest";\nit("pins", () => {});\n' } },
    ]), "RA27");
    expect(r.out).toContain("✗ WI-RA27.* linkage");
    expect(r.out).toContain("✗ WI-RA27.1 has no test");
    expect(r.status).toBe(1);
  });

  it("a test file no vitest tier collects does not count", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback"), [
      { message: "fix: x (WI-RA27.1)", files: { "misc/rollback.test.ts": TEST("WI-RA27.1") } },
    ]), "RA27");
    expect(r.out).toContain("✗ misc/rollback.test.ts (WI-RA27.1) is named as a test, but no vitest tier collects it");
    expect(r.status).toBe(1);
  });

  it("a collected test file that declares no case does not count", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback"), [
      { message: "fix: x (WI-RA27.1)", files: { "src/rollback.test.ts": NO_CASE("WI-RA27.1") } },
    ]), "RA27");
    expect(r.out).toContain("✗ src/rollback.test.ts (WI-RA27.1) present but declares no it()/test() case");
    expect(r.status).toBe(1);
  });

  it("a Rust test nothing mounts does not count", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rust"), [
      { message: "fix: x (WI-RA27.1)", files: { "src-tauri/src/foo.rs": "// no tests here\n", "src-tauri/src/foo.test.rs": "// WI-RA27.1 — fixture\n#[test]\nfn pins() {}\n" } },
    ]), "RA27");
    expect(r.out).toContain("✗ src-tauri/src/foo.test.rs (WI-RA27.1) present but no .rs beside it includes it");
    expect(r.status).toBe(1);
  });

  it("a work item with neither a test nor a mark fails", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback"), [
      { message: "fix(nav): roll back (WI-RA27.1)", files: { "src/nav/rollback.ts": "export {};\n" } },
    ]), "RA27");
    expect(r.out).toContain("✗ WI-RA27.1 has no test");
    expect(r.status).toBe(1);
  });

  it("an empty no-test mark is no mark", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback [no-test: ]"), [
      { message: "fix(nav): roll back (WI-RA27.1)", files: { "src/nav/rollback.ts": "export {};\n" } },
    ]), "RA27");
    expect(r.out).toContain("✗ WI-RA27.1 has no test");
    expect(r.status).toBe(1);
  });

  it("a no-test mark that a test contradicts fails", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — rollback [no-test: docs only]"), [
      { message: "fix: x (WI-RA27.1)", files: { "src/rollback.test.ts": TEST("WI-RA27.1") } },
    ]), "RA27");
    expect(r.out).toContain("✗ WI-RA27.1 is marked [no-test: docs only] but has tests: src/rollback.test.ts");
    expect(r.status).toBe(1);
  });

  it("a work item declared under no phase heading fails", () => {
    const plan = `# Plan\n\n- **WI-RA27.9 — stray**\n\n${phasePlan("RA27", "WI-RA27.1 — wording [no-test: docs]")}`;
    const r = run(repo(plan, [{ message: "docs: x (WI-RA27.1, WI-RA27.9)" }]), "RA27");
    expect(r.out).toContain("✗ WI-RA27.9 (plan line 3) is declared under no phase heading");
    expect(r.status).toBe(1);
  });

  it("a phase the plan does not carry fails rather than passing empty", () => {
    const r = run(repo(phasePlan("RA27", "WI-RA27.1 — wording [no-test: docs]"), [{ message: "docs: x (WI-RA27.1)" }]), "RA26");
    expect(r.out).toContain("✗ phase RA26: no '#### Phase RA26 —' heading in the plan");
    expect(r.status).toBe(1);
  });

  it("fails closed on a missing plan", () => {
    const r = run(repo(null), "RA27");
    expect(r.out).toContain("plan unreadable");
    expect(r.status).toBe(1);
  });
});

/** The checker's phase table, read from its source: phase id → lane namespaces. */
function phaseTable() {
  const body = /PHASE_TABLE="\n([\s\S]*?)\n"/.exec(readFileSync(SCRIPT, "utf8"))[1];
  return body.split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/));
}

/** A plan with every phase of the table, each lane one no-test work item, all tagged in one commit. */
function wholePlan({ drop = null, extraPhase = null, extraLane = null } = {}) {
  let plan = "# Plan\n\n### Wave 1\n\n";
  const ids = [];
  for (const [phase, ...lanes] of phaseTable()) {
    if (phase === drop) continue;
    const wave = /^Wave(\d+)$/.exec(phase);
    plan += wave ? `### Wave ${wave[1]} (fixture)\n\n` : `#### Phase ${phase} — fixture\n`;
    const all = phase === "RA27" && extraLane ? [...lanes, extraLane] : lanes;
    for (const lane of all) {
      plan += `- **WI-${lane}.1 — item [no-test: fixture]**\n`;
      ids.push(`WI-${lane}.1`);
    }
    if (wave) plan += "\n### Wave 1\n\n";
  }
  if (extraPhase) {
    plan += `#### Phase ${extraPhase} — not in the table\n- **WI-${extraPhase}.1 — item [no-test: fixture]**\n`;
    ids.push(`WI-${extraPhase}.1`);
  }
  return repo(plan, [{ message: `docs: every item (${ids.join(", ")})` }]);
}

describe("all — the table and the plan agree both ways", () => {
  it("exits 0 when every table phase is in the plan and every phase passes", () => {
    const r = run(wholePlan(), "all");
    expect(r.out).toContain("✓ phase Wave4 is in the plan and in the table");
    expect(r.status, r.out).toBe(0);
  });

  it("fails on a plan phase the table does not list", () => {
    const r = run(wholePlan({ extraPhase: "RA99" }), "all");
    expect(r.out).toContain("✗ phase RA99 is in the plan but not in this checker's table");
    expect(r.status).toBe(1);
  });

  it("fails on a table phase the plan does not carry", () => {
    const r = run(wholePlan({ drop: "RA27" }), "all");
    expect(r.out).toContain("✗ phase RA27 is in this checker's table but not in the plan");
    expect(r.status).toBe(1);
  });

  it("fails on a lane the table does not list for its phase", () => {
    const r = run(wholePlan({ extraLane: "RA27B" }), "all");
    expect(r.out).toMatch(/✗ phase RA27 namespaces differ — plan: RA27 RA27B table: RA27/);
    expect(r.status).toBe(1);
  });
});

describe("invocation", () => {
  const root = repo(phasePlan("RA27", "WI-RA27.1 — wording [no-test: docs]"), [{ message: "docs: x (WI-RA27.1)" }]);
  it.each([
    ["no phase", []],
    ["an unknown phase", ["RA99"]],
    ["two phases", ["RA27", "RA26"]],
    ["an unknown flag", ["RA27", "--nope"]],
  ])("exits 64 on %s", (_label, args) => {
    expect(run(root, ...args).status).toBe(64);
  });
});
