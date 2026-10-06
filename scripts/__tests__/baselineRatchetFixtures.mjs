/**
 * Scratch-repository fixtures for the baseline ratchet's self-tests: build a
 * repository whose single commit is the merge base, mutate its working tree,
 * and run the REAL `scripts/check-baseline-ratchet.mjs` against it with a
 * manifest of the test's choosing.
 *
 * Shared by `scripts/check-baseline-ratchet.test.mjs` (the comparison modes)
 * and `scripts/check-baseline-ratchet-comparators.test.mjs` (the custom
 * comparators and the shipped manifest).
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCRIPT = path.join(REPO, "scripts", "check-baseline-ratchet.mjs");

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}

/** Scratch repo whose single commit ("base") holds `baseFiles`. */
export function scratchRepo(baseFiles) {
  const dir = mkdtempSync(path.join(tmpdir(), "baseline-ratchet-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "gate@example.test");
  git("config", "user.name", "Gate Fixture");
  git("config", "commit.gpgsign", "false");
  writeFiles(dir, baseFiles);
  git("add", "-A");
  git("commit", "-m", "base");
  return dir;
}

/** Apply working-tree changes on top of the base commit. `null` deletes. */
export function mutate(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) rmSync(path.join(dir, rel), { force: true });
    else writeFiles(dir, { [rel]: content });
  }
}

export function run(dir, manifest, { baseRef = "main" } = {}) {
  const manifestPath = path.join(dir, "ratchet-manifest.json");
  writeFileSync(
    manifestPath,
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
  );
  const res = spawnSync(
    process.execPath,
    [SCRIPT, baseRef, "--root", dir, "--manifest", manifestPath],
    { encoding: "utf8" },
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export const manifestOf = (entries, allowRaise = []) => ({ entries, allowRaise });
