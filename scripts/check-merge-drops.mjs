#!/usr/bin/env node
/**
 * Detect a merge resolution that silently DISCARDED one side's change.
 *
 * Git shows a conflict only where hunks overlap. When one side edits line 160
 * and the other MOVES lines 220-290 into a new file, resolving with `--ours`
 * or `--theirs` throws the other edit away and the merge is green — no
 * conflict marker, no failing test, nothing to review. Both directions of that
 * happened in the origin/main merge on this branch:
 *
 *   - `fileOpen.ts` taken from our side would have reverted main's
 *     ownership-aware activate, which lived inside the switch we had moved out.
 *   - Rebuilding it from main's side then dropped OUR ingest routing.
 *
 * The check is a four-way comparison per file: base, ours, theirs, merged. If
 * the merged content is byte-identical to one side while the OTHER side had
 * also changed that file, that side's change is gone.
 *
 * A hit is not automatically a bug. Taking one side wholesale is correct when
 * the other side's change was RELOCATED — re-applied in a file the other side
 * moved the code to. That is why this reports and asks rather than failing
 * blind: an acknowledged drop goes in `scripts/merge-drop-allowlist.json` with
 * the file it moved to, so the claim is written down and checkable.
 *
 * Usage:
 *   node scripts/check-merge-drops.mjs            # in-progress merge, else HEAD
 *   node scripts/check-merge-drops.mjs <commit>   # a specific merge commit
 *
 * With a merge IN PROGRESS (MERGE_HEAD present) it compares the WORKING TREE,
 * so a discarded side is caught before the merge commit exists — which is the
 * only moment the fix is still cheap.
 *
 * Exit 0 when every drop is accounted for; 1 when one is not, and 1 whenever
 * the merge cannot be read: not a repository, a commit argument that does not
 * resolve, an octopus merge, no merge base, a failing `git diff`, or an
 * acknowledgement list with an empty or stale entry.
 *
 * Run from the repository root: the acknowledgement list and, for an
 * in-progress merge, the working-tree files are read relative to it.
 *
 * @coordinates-with scripts/merge-drop-allowlist.json — the acknowledgement list
 * @coordinates-with scripts/check-merge-drops.test.mjs — runs this against real scratch merges
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ALLOWLIST = "scripts/merge-drop-allowlist.json";
/**
 * The file types a silent drop is looked for in: code, and the text that
 * behaves like code — workflows, shell gates, docs that tests join against,
 * Cargo manifests. A lane merge discards a change in a `.yml` as easily as in
 * a `.ts`.
 */
const CHECKED_FILE = /\.(ts|tsx|rs|json|mjs|css|yml|yaml|sh|md|toml)$/;

/**
 * `git` with arguments; stdout, or an empty string on non-zero exit.
 *
 * Only for questions where "no" is a legitimate answer (is this a repository,
 * does this ref resolve, is there a merge base). The caller must turn the
 * empty answer into a decision — see `gitOrFail` for everything else.
 */
function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/**
 * `git` for commands whose failure means the check cannot be made. An empty
 * string here used to read as "no files changed", i.e. as a clean merge.
 */
function gitOrFail(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return fail(`git ${args.join(" ")} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

/**
 * The acknowledgement list, validated. Keys starting with `_` are notes.
 *
 * Every entry must name a file that still exists and say, in words, where the
 * dropped change was re-applied. Checked on every run, merge or not: the list
 * outlives the merge it was written for, and an entry for a path that has
 * since moved would silently acknowledge nothing while looking like cover.
 */
function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  } catch (error) {
    return fail(`Cannot parse ${ALLOWLIST}: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(`${ALLOWLIST} must be a JSON object of path -> where the change was re-applied.`);
  }
  const entries = {};
  const problems = [];
  for (const [path, note] of Object.entries(parsed)) {
    if (path.startsWith("_")) continue;
    if (typeof note !== "string" || !note.trim()) {
      problems.push(`${path}: must say where the change was re-applied (a non-empty string).`);
    } else if (!existsSync(path)) {
      problems.push(`${path}: names a file that does not exist — delete the stale entry.`);
    } else {
      entries[path] = note;
    }
  }
  if (problems.length > 0) fail(`${ALLOWLIST}:\n   ${problems.join("\n   ")}`);
  return entries;
}

/** File content at a revision, or null when the file does not exist there. */
function blob(rev, path) {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const gitDir = git("rev-parse", "--git-dir").trim();
if (!gitDir) fail("Not inside a git repository — there is no merge to read.");
const mergeHeadPath = join(gitDir, "MERGE_HEAD");
const inProgress = !process.argv[2] && existsSync(mergeHeadPath);

const allow = readAllowlist();

/** Only two-parent merges are modelled; a third parent would go unexamined. */
function refuseOctopus(label, parentCount) {
  if (parentCount > 2) {
    fail(`${label} has ${parentCount} parents — an octopus merge cannot be checked side against side.`);
  }
}

let merged, ours, theirs;
if (inProgress) {
  // Merged content is the WORKING TREE, read from disk rather than a rev.
  merged = null;
  ours = gitOrFail("rev-parse", "HEAD").trim();
  const heads = readFileSync(mergeHeadPath, "utf8").trim().split("\n").filter(Boolean);
  refuseOctopus("The in-progress merge", heads.length + 1);
  theirs = heads[0];
} else {
  const mergeRef = process.argv[2] ?? "HEAD";
  // A ref that names nothing has no parents either, which is exactly what a
  // non-merge commit looks like. Tell them apart before counting.
  if (!git("rev-parse", "--verify", "--quiet", `${mergeRef}^{commit}`).trim()) {
    fail(`${mergeRef} does not resolve to a commit.`);
  }
  const parents = gitOrFail("rev-list", "--parents", "-n", "1", mergeRef).trim().split(/\s+/);
  if (parents.length < 3) {
    console.log(`✅ ${mergeRef} is not a merge commit and no merge is in progress — nothing to check.`);
    process.exit(0);
  }
  refuseOctopus(`Merge ${mergeRef}`, parents.length - 1);
  [merged, ours, theirs] = parents;
}
const base = git("merge-base", ours, theirs).trim();
if (!base) fail(`No merge base between ${ours} and ${theirs}.`);

/**
 * Files each side changed since the base, as sets.
 *
 * `core.quotePath=false` because git otherwise prints a non-ASCII path as a
 * quoted, octal-escaped string, which matches no extension and no file.
 */
const changed = (rev) =>
  new Set(
    gitOrFail("-c", "core.quotePath=false", "diff", "--name-only", `${base}..${rev}`)
      .split("\n")
      .filter(Boolean)
      .filter((p) => CHECKED_FILE.test(p))
  );

const oursChanged = changed(ours);
const theirsChanged = changed(theirs);
const bothTouched = [...oursChanged].filter((p) => theirsChanged.has(p)).sort();

const drops = [];

for (const path of bothTouched) {
  const [b, o, t] = [base, ours, theirs].map((rev) => blob(rev, path));
  // In-progress: the resolution lives in the working tree, not in any rev.
  const m = merged === null
    ? (existsSync(path) ? readFileSync(path, "utf8") : null)
    : blob(merged, path);
  // A file deleted on a side is a resolution question of its own, not a
  // silent drop — `git` always conflicts on modify/delete.
  if (b === null || o === null || t === null || m === null) continue;
  // Both sides made the SAME change (a cherry-pick on each branch): the result
  // equals both, and nothing was discarded.
  if (o === t) continue;

  if (m === t && o !== b) drops.push({ path, lost: "ours", kept: "theirs" });
  else if (m === o && t !== b) drops.push({ path, lost: "theirs", kept: "ours" });
}

if (drops.length === 0) {
  console.log(
    `✅ Merge-drop check passed (${bothTouched.length} file(s) changed on both sides, none resolved by discarding a side).`
  );
  process.exit(0);
}

const unacknowledged = drops.filter((d) => !allow[d.path]);

const label = merged === null ? "In-progress merge" : `Merge ${merged.slice(0, 8)}`;
console.log(`${label}: ${drops.length} file(s) resolved by taking one side whole.\n`);
for (const d of drops) {
  const note = allow[d.path];
  const mark = note ? "✔" : "✗";
  console.log(`  ${mark} ${d.path}`);
  console.log(`      kept ${d.kept}; ${d.lost === "ours" ? "OUR" : "THEIR"} change to this file is not in the result`);
  if (note) console.log(`      acknowledged: ${note}`);
}

if (unacknowledged.length > 0) {
  console.error(
    `\n❌ ${unacknowledged.length} unacknowledged drop(s).\n` +
      `   If the change was RELOCATED, say where in ${ALLOWLIST}:\n` +
      `     { "${unacknowledged[0].path}": "re-applied in path/to/new/home.ts" }\n` +
      `   If it was not, the change is gone — restore it.`
  );
  process.exit(1);
}

console.log(`\n✅ All ${drops.length} drop(s) acknowledged as relocations.`);
process.exit(0);
