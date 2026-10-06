/**
 * The one behaviour in `clean-dev.sh` that is not recoverable if it is wrong.
 *
 * `cargo clean` removes the whole target tree and cannot spare a subdirectory,
 * so a locally built `target/release/bundle/` — code-signed and notarized but
 * not yet uploaded — is gone with it, and getting it back costs a re-sign and a
 * re-notarize against Apple's quota. The script therefore REFUSES rather than
 * deleting silently.
 *
 * That guard is exactly the kind that quietly stops working, and reading the
 * source is not proof it runs. `--dry-run` exists so this can be exercised for
 * real without a code path that deletes anything.
 *
 * @coordinates-with scripts/clean-dev.sh
 * @module scripts/clean-dev.test
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// WI-RA13B.7 — every run happens in a scratch root holding a copy of the
// script (it `cd`s to its own parent directory). Fixtures used to be created
// in the REAL repository — `dev-docs/grills/…` and `src-tauri/target/…` — and
// a sibling gate test scanning the tree under the same parallel pool saw
// `dev-docs/` appear and vanish mid-walk (ENOENT on scandir). A scratch root
// also makes the "no bundle" and "no grills" cases unconditional.
let ROOT;
beforeEach(() => {
  ROOT = mkdtempSync(path.join(tmpdir(), "clean-dev-"));
  mkdirSync(path.join(ROOT, "scripts"));
  copyFileSync(path.join(REPO, "scripts/clean-dev.sh"), path.join(ROOT, "scripts/clean-dev.sh"));
});

function run(args) {
  const r = spawnSync("bash", [path.join(ROOT, "scripts/clean-dev.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  // A timeout lands in `error` and may leave `status` as bash's own exit code;
  // unchecked, a hang would pass every status assertion below, only late.
  if (r.error) throw r.error;
  return r;
}

function withBundle() {
  mkdirSync(path.join(ROOT, "src-tauri/target/release/bundle"), { recursive: true });
}

describe("fixture isolation", () => {
  it("runs against a scratch root, never the repository", () => {
    expect(path.relative(REPO, ROOT).startsWith("..")).toBe(true);
    expect(run(["--help"]).status).toBe(0);
  });
});

describe("bundle guard", () => {
  it("refuses when target/release/bundle exists", () => {
    withBundle();
    const r = run(["--dry-run"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing");
    expect(r.stderr).toContain("--include-bundle");
  });

  it("refuses BEFORE running cargo clean, not after", () => {
    // The ordering is the whole guard: a refusal printed after the deletion
    // would be a eulogy, not a gate.
    withBundle();
    const r = run(["--dry-run"]);
    expect(r.stdout).not.toContain("cargo clean");
  });

  it("names the release-check command so the reader can resolve it", () => {
    withBundle();
    expect(run(["--dry-run"]).stderr).toContain("gh release view");
  });

  it("proceeds once --include-bundle is given", () => {
    withBundle();
    const r = run(["--dry-run", "--include-bundle"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY-RUN: cargo clean");
  });

  it("proceeds when no bundle exists", () => {
    const r = run(["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY-RUN: cargo clean");
  });
});

describe("--help", () => {
  // The help text used to be a hardcoded `sed -n '2,30p'` line range, which
  // overshot the header and printed four lines of shell (`set -uo pipefail`,
  // the `cd`, `ROOT=`). A fixed range silently rots every time the header
  // grows, so the fix is to stop at the first non-comment line instead.
  it("prints the header without leaking shell code", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Reclaim dev-box disk");
    expect(r.stdout).not.toContain("set -uo pipefail");
    expect(r.stdout).not.toContain("ROOT=");
    expect(r.stdout).not.toMatch(/^cd /m);
  });

  it("still documents every tier", () => {
    const out = run(["--help"]).stdout;
    for (const tier of ["1", "2", "3"]) expect(out).toMatch(new RegExp(`^\\s*${tier}\\s`, "m"));
  });
});

describe("spike probe artifacts", () => {
  // Spike probes (60-ai-governance.md §7) are separate cargo/npm projects nested
  // under dev-docs/grills/, so the app's `cargo clean` cannot reach them and
  // Cargo never GCs. Three had accumulated 818 MB whose probe sources no longer
  // existed. The sweep must take the artifact dirs and NOTHING else: the spike
  // reports are the evidence §7 requires.
  const FIXTURE = "dev-docs/grills/__clean-dev-fixture__";

  function withFixture() {
    const at = (rel) => path.join(ROOT, FIXTURE, rel);
    mkdirSync(at("probe/target/debug"), { recursive: true });
    mkdirSync(at("probe/node_modules/left-pad"), { recursive: true });
    mkdirSync(at("probe/src"), { recursive: true });
    writeFileSync(at("spike-report.md"), "# findings\n");
  }

  const actions = (args) =>
    run(args)
      .stdout.split("\n")
      .filter((l) => l.startsWith("DRY-RUN:"))
      .join("\n");

  it("tier 1 sweeps orphaned target/ and node_modules/ under dev-docs/grills", () => {
    withFixture();
    const out = actions(["1", "--dry-run"]);
    expect(out).toContain("dev-docs/grills/__clean-dev-fixture__/probe/target");
    expect(out).toContain("dev-docs/grills/__clean-dev-fixture__/probe/node_modules");
  });

  it("keeps the spike report and the probe source — they are the evidence", () => {
    withFixture();
    const out = actions(["1", "--dry-run"]);
    expect(out).not.toContain("spike-report.md");
    expect(out).not.toContain("probe/src");
  });

  it("does not recurse into a swept directory", () => {
    // Listing target/debug separately would mean the prune is missing, and the
    // second rm -rf would operate on an already-deleted path.
    withFixture();
    expect(actions(["1", "--dry-run"])).not.toContain("probe/target/debug");
  });

  it("is a no-op when dev-docs/grills is absent", () => {
    const r = run(["1", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("dev-docs/grills");
  });
});

describe("tiers", () => {
  // Assertions are anchored to the DRY-RUN action lines, not to raw stdout:
  // the BEFORE block runs `du -sh ~/.cargo/registry`, so a bare
  // `not.toContain(".cargo/registry")` matches a size report and proves nothing
  // about what would be deleted.
  const actions = (args) =>
    run(args)
      .stdout.split("\n")
      .filter((l) => l.startsWith("DRY-RUN:"))
      .join("\n");

  it("tier 1 removes the regenerable report trees", () => {
    // coverage/ (52 MB) and reports/ (16 MB) are rebuilt by `pnpm test:coverage`
    // and `pnpm dup` / `mutation:ts`. They are project-local and need no
    // network, which is exactly tier 1's remit — dist/ was already here.
    const out = actions(["1", "--dry-run"]);
    expect(out).toMatch(/\bcoverage\b/);
    expect(out).toMatch(/\breports\b/);
  });

  it("tier 1 does not touch machine-wide cargo caches", () => {
    const out = actions(["1", "--dry-run"]);
    expect(out).toContain("cargo clean");
    expect(out).not.toMatch(/\.cargo/);
  });

  it("tier 2 adds the cargo caches but keeps the registry index", () => {
    const out = actions(["2", "--dry-run"]);
    expect(out).toMatch(/registry\/cache/);
    expect(out).toMatch(/registry\/src/);
    // Deleting the index forces a full crates.io index re-fetch for no gain.
    expect(out).not.toMatch(/registry\/index/);
  });

  it("tier 3 adds pnpm store prune", () => {
    expect(run(["3", "--dry-run"]).stdout).toContain("pnpm store prune");
  });

  it("rejects an unknown argument instead of guessing a tier", () => {
    const r = run(["--nuke-everything", "--dry-run"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown argument");
  });
});
