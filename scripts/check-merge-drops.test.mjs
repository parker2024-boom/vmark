// WI-RA13A.4 — the merge-drop gate catches a resolution that discarded one side, in a commit or in progress, and never passes a merge it could not read
/**
 * Runs the REAL `scripts/check-merge-drops.mjs` with a scratch git repository
 * as its working directory. Each scenario builds a real three-way history
 * (base, ours, theirs) and a real merge, because the gate's whole subject is
 * what git recorded.
 *
 * The shape under test: both sides changed the same file in NON-overlapping
 * places, so git reports no conflict, and the resolution kept one side's file
 * whole. Nothing else in the toolchain notices that.
 *
 * @coordinates-with scripts/check-merge-drops.mjs — the gate under test
 * @module scripts/check-merge-drops.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-merge-drops.mjs");

const BASE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
/** Our edit touches the top of the file, theirs the bottom: no overlap. */
const OURS = BASE.replace("line 1\n", "line 1 (ours)\n");
const THEIRS = BASE.replace("line 12\n", "line 12 (theirs)\n");

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function write(root, rel, body) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
}

/**
 * A repo with `main` (ours) and `theirs` diverged from a common base.
 * `ours` / `theirs` map path -> content written on that side; `null` deletes.
 */
function diverged({ base = { "src/a.ts": BASE }, ours = { "src/a.ts": OURS }, theirs = { "src/a.ts": THEIRS } } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "merge-drops-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "core.autocrlf", "false");
  const apply = (files) => {
    for (const [rel, body] of Object.entries(files)) {
      if (body === null) rmSync(path.join(root, rel));
      else write(root, rel, body);
    }
    git(root, "add", "-A");
  };
  apply({ "seed.txt": "seed\n", ...base });
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "theirs");
  apply(theirs);
  git(root, "commit", "-qm", "theirs", "--allow-empty");
  git(root, "checkout", "-q", "main");
  apply(ours);
  git(root, "commit", "-qm", "ours", "--allow-empty");
  return root;
}

/** Start the merge without committing; returns whether git saw conflicts. */
function beginMerge(root) {
  const r = spawnSync("git", ["merge", "--no-commit", "--no-ff", "theirs"], { cwd: root, encoding: "utf8" });
  return r.status !== 0;
}

/** Resolve `rel` by taking one side's file whole, then stage it. */
function take(root, side, rel) {
  git(root, "checkout", side === "ours" ? "HEAD" : "theirs", "--", rel);
}

const commitMerge = (root) => git(root, "commit", "-qm", "merge", "--no-edit");

function run(root, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  return { ...r, out: r.stdout + r.stderr };
}

const allow = (root, entries) => write(root, "scripts/merge-drop-allowlist.json", JSON.stringify(entries));

describe("check-merge-drops.mjs — a committed merge", () => {
  it("exits 0 when HEAD is not a merge", () => {
    const r = run(diverged());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("HEAD is not a merge commit and no merge is in progress");
  });

  it("exits 0 when git combined both sides", () => {
    const root = diverged();
    beginMerge(root);
    commitMerge(root);
    const r = run(root);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("1 file(s) changed on both sides, none resolved by discarding a side");
  });

  it("fails when the merge kept OUR file whole and their change is gone", () => {
    const root = diverged();
    beginMerge(root);
    take(root, "ours", "src/a.ts");
    commitMerge(root);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("✗ src/a.ts");
    expect(r.out).toContain("kept ours; THEIR change to this file is not in the result");
    expect(r.out).toContain("1 unacknowledged drop(s)");
  });

  it("fails when the merge kept THEIR file whole and our change is gone", () => {
    const root = diverged();
    beginMerge(root);
    take(root, "theirs", "src/a.ts");
    commitMerge(root);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("kept theirs; OUR change to this file is not in the result");
  });

  it("a `-s ours` merge, which discards their whole side, is caught", () => {
    const root = diverged();
    git(root, "merge", "-q", "-s", "ours", "theirs", "-m", "merge");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("✗ src/a.ts");
  });

  it("names every dropped file, and only those", () => {
    const root = diverged({
      base: { "src/a.ts": BASE, "src/b.tsx": BASE, "src/c.rs": BASE },
      ours: { "src/a.ts": OURS, "src/b.tsx": OURS, "src/c.rs": OURS },
      theirs: { "src/a.ts": THEIRS, "src/b.tsx": THEIRS, "src/c.rs": THEIRS },
    });
    beginMerge(root);
    take(root, "ours", "src/a.ts");
    take(root, "theirs", "src/c.rs");
    commitMerge(root);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("✗ src/a.ts");
    expect(r.out).toContain("✗ src/c.rs");
    expect(r.out).not.toContain("src/b.tsx");
    expect(r.out).toContain("2 unacknowledged drop(s)");
  });

  it("a file only ONE side changed is not a drop, whichever version the merge has", () => {
    const root = diverged({ ours: {}, theirs: { "src/a.ts": THEIRS } });
    beginMerge(root);
    commitMerge(root);
    const r = run(root);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("0 file(s) changed on both sides");
  });

  it("both sides making the IDENTICAL change is not a drop", () => {
    const root = diverged({ ours: { "src/a.ts": OURS }, theirs: { "src/a.ts": OURS } });
    beginMerge(root);
    commitMerge(root);
    const r = run(root);
    expect(r.status, r.out).toBe(0);
  });

  it("a modify/delete resolution is git's conflict to raise, not a silent drop", () => {
    const root = diverged({ theirs: { "src/a.ts": null } });
    expect(beginMerge(root)).toBe(true);
    git(root, "add", "src/a.ts");
    commitMerge(root);
    const r = run(root);
    expect(r.status, r.out).toBe(0);
  });

  it("checks a named merge commit even when HEAD has moved on", () => {
    const root = diverged();
    beginMerge(root);
    take(root, "ours", "src/a.ts");
    commitMerge(root);
    const merge = git(root, "rev-parse", "HEAD");
    write(root, "later.txt", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "later");
    expect(run(root).status).toBe(0);
    const r = run(root, [merge]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`Merge ${merge.slice(0, 8)}`);
  });

  it("a file with a non-ASCII name is checked like any other", () => {
    const rel = "src/标题.ts";
    const root = diverged({ base: { [rel]: BASE }, ours: { [rel]: OURS }, theirs: { [rel]: THEIRS } });
    beginMerge(root);
    take(root, "ours", rel);
    commitMerge(root);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`✗ ${rel}`);
  });

  it("CRLF content is compared byte for byte", () => {
    const crlf = (s) => s.replaceAll("\n", "\r\n");
    const root = diverged({
      base: { "src/a.ts": crlf(BASE) },
      ours: { "src/a.ts": crlf(OURS) },
      theirs: { "src/a.ts": crlf(THEIRS) },
    });
    beginMerge(root);
    take(root, "theirs", "src/a.ts");
    commitMerge(root);
    expect(run(root).status).toBe(1);
  });

  it.each(["src/a.ts", "src/a.tsx", "src-tauri/a.rs", "data/a.json", "scripts/a.mjs", "src/a.css"])(
    "%s is a checked file type",
    (rel) => {
      const root = diverged({ base: { [rel]: BASE }, ours: { [rel]: OURS }, theirs: { [rel]: THEIRS } });
      beginMerge(root);
      take(root, "ours", rel);
      commitMerge(root);
      expect(run(root).status).toBe(1);
    },
  );

  // WI-RA13B.7 — workflows, shell gates, docs and Cargo manifests are where a
  // lane merge drops a change as easily as in code.
  it.each([".github/workflows/ci.yml", "a.yaml", "scripts/gate.sh", "docs/a.md", "src-tauri/Cargo.toml"])(
    "%s is checked: keeping one side whole is a drop",
    (rel) => {
      const root = diverged({ base: { [rel]: BASE }, ours: { [rel]: OURS }, theirs: { [rel]: THEIRS } });
      beginMerge(root);
      take(root, "ours", rel);
      commitMerge(root);
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`✗ ${rel}`);
    },
  );

  it("file types outside the checked set are not examined", () => {
    const rel = "docs/a.txt";
    const root = diverged({ base: { [rel]: BASE }, ours: { [rel]: OURS }, theirs: { [rel]: THEIRS } });
    beginMerge(root);
    take(root, "ours", rel);
    commitMerge(root);
    const r = run(root);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("0 file(s) changed on both sides");
  });
});

describe("check-merge-drops.mjs — a merge in progress", () => {
  it("reads the WORKING TREE, so a discarded side is caught before the commit exists", () => {
    const root = diverged();
    beginMerge(root);
    take(root, "ours", "src/a.ts");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("In-progress merge: 1 file(s) resolved by taking one side whole");
    expect(r.out).toContain("kept ours; THEIR change");
  });

  it("sees an UNSTAGED resolution too", () => {
    const root = diverged();
    beginMerge(root);
    write(root, "src/a.ts", THEIRS);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("kept theirs; OUR change");
  });

  it("exits 0 while the working tree still carries both changes", () => {
    const root = diverged();
    beginMerge(root);
    const r = run(root);
    expect(r.status, r.out).toBe(0);
  });

  it("an explicit commit argument overrides the in-progress merge", () => {
    const root = diverged();
    const ours = git(root, "rev-parse", "HEAD");
    beginMerge(root);
    take(root, "ours", "src/a.ts");
    const r = run(root, [ours]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("is not a merge commit");
  });
});

describe("check-merge-drops.mjs — the acknowledgement list", () => {
  function droppedTheirs() {
    const root = diverged();
    beginMerge(root);
    take(root, "ours", "src/a.ts");
    commitMerge(root);
    return root;
  }

  it("an acknowledged drop passes and prints where the change went", () => {
    const root = droppedTheirs();
    allow(root, { _comment: "notes", "src/a.ts": "re-applied in src/b.ts" });
    const r = run(root);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("✔ src/a.ts");
    expect(r.out).toContain("acknowledged: re-applied in src/b.ts");
    expect(r.out).toContain("All 1 drop(s) acknowledged as relocations");
  });

  it("acknowledging a DIFFERENT file does not cover this one", () => {
    const root = droppedTheirs();
    write(root, "src/other.ts", "x\n");
    allow(root, { "src/other.ts": "re-applied in src/b.ts" });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("✗ src/a.ts");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["true", true],
    ["a number", 1],
    ["an object", { moved: "somewhere" }],
  ])("an acknowledgement that is %s does not acknowledge anything", (_label, value) => {
    const root = droppedTheirs();
    allow(root, { "src/a.ts": value });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("must say where the change was re-applied");
  });

  it("an entry naming a file that no longer exists fails as stale, even with no merge to check", () => {
    const root = diverged();
    allow(root, { "src/moved-away.ts": "re-applied in src/b.ts" });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/moved-away.ts");
    expect(r.out).toContain("names a file that does not exist");
  });

  it("underscore-prefixed keys are notes, not entries", () => {
    const root = diverged();
    allow(root, { _comment: "x", _verified: ["a", "b"] });
    const r = run(root);
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ["unparseable JSON", "{ nope"],
    ["an array", "[]"],
    ["null", "null"],
  ])("an allowlist that is %s fails", (_label, body) => {
    const root = droppedTheirs();
    write(root, "scripts/merge-drop-allowlist.json", body);
    const r = run(root);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("acknowledged as relocations");
  });
});

describe("check-merge-drops.mjs — what it cannot read never passes", () => {
  it("a commit argument that does not resolve fails instead of reading as 'not a merge'", () => {
    const r = run(diverged(), ["no-such-ref"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("no-such-ref does not resolve to a commit");
    expect(r.out).not.toContain("nothing to check");
  });

  it("outside a git repository it fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "merge-drops-norepo-"));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("nothing to check");
  });

  it("an octopus merge is refused rather than half-checked", () => {
    const root = diverged();
    git(root, "checkout", "-qb", "third", "main~1");
    write(root, "third.txt", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "third");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "theirs", "third", "-m", "octopus");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("has 3 parents");
  });

  it("histories with no common ancestor fail", () => {
    const root = diverged();
    git(root, "checkout", "-q", "--orphan", "island");
    git(root, "rm", "-rqf", ".");
    write(root, "src/a.ts", THEIRS);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "island");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--allow-unrelated-histories", "-s", "ours", "island", "-m", "merge");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No merge base");
  });
});
