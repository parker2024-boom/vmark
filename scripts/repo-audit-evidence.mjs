#!/usr/bin/env node
/**
 * The facts `scripts/check-repo-audit-phase.sh` asserts on, gathered in one
 * pass: which phases the plan declares, which work items each phase owns, and
 * which test files stand behind each work item — and whether a runner
 * collects each of those files.
 *
 * Purpose: a phase gate written as greps answers "does this text exist". The
 * questions here are structural — the work item a heading owns, the files a
 * tagged commit touched, the files a vitest tier would run — so they are
 * computed from the plan's declarations, git's history and vitest's own file
 * list, and printed as tab-separated records the shell side turns into
 * assertions.
 *
 * Records (one per line, fields separated by a tab):
 *   PHASE     <phase id>  <plan line>
 *   WI        <phase id>  <work item>  <no-test reason, or empty>
 *   ORPHAN    <work item> <plan line>        declared under no phase heading
 *   EVIDENCE  <work item> <header|commit>  <file>  <state>
 * where state is `vitest`, `cargo`, `journey`, `uncollected` (a test-named
 * file no runner collects) or `missing` (named by a commit, gone from disk).
 *
 * Key decisions:
 *   - A phase is a `#### Phase <id> —` heading. A `### Wave <n>` heading that
 *     declares work items directly is a phase too, `Wave<n>`: the plan's last
 *     wave lists its items with no phase heading of its own.
 *   - Work items are read from the DECLARATION forms check-wi-linkage.sh
 *     accepts, never from prose; the shell side cross-checks the two parsers.
 *   - Test evidence is a test-file header naming the item in its first 30
 *     lines (the window check-wi-linkage.sh reads), or a test file added or
 *     changed by a commit whose message tags the item, `(WI-…)`, in the range
 *     the shell side passes in. A test that a tagged commit deleted is not
 *     evidence.
 *   - "Collected" is asked of vitest itself (`vitest list --filesOnly`, with
 *     the checker's own configs over the tree under test), not re-derived
 *     from globs. Rust tests and journeys are left to the shell side's
 *     syntax probes (scripts/lib/dod-assertions.sh).
 *   - An item the plan marks `[no-test: <reason>]` on its declaration line
 *     needs no test; the reason must be non-empty.
 *   - Fails closed (exit 2) on an unreadable plan, a failed git call or a
 *     vitest list that does not answer.
 *
 * Usage: node scripts/repo-audit-evidence.mjs <root> <plan> <git range>
 *
 * @coordinates-with scripts/check-repo-audit-phase.sh — the assertions over these records
 * @coordinates-with scripts/check-wi-linkage.sh — the declaration grammar and header window mirrored here
 * @coordinates-with scripts/check-repo-audit-phase.test.mjs — the self-test
 * @module scripts/repo-audit-evidence
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/isMainModule.mjs";

const WI = String.raw`WI-[A-Z0-9]+(?:\.[0-9]+)?[a-z]?`;
const WI_ANYWHERE = new RegExp(WI, "g");
const HEADER_LINES = 30;
const TEST_NAME = /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/;
const isTestFile = (f) => TEST_NAME.test(f) || f.endsWith(".test.rs") || /^e2e\/journeys\/[^/]+\.mjs$/.test(f);

/** The work item a plan line DECLARES (check-wi-linkage.sh's four forms), or null. */
function declaredId(line) {
  const id = new RegExp(`^${WI}`);
  let rest = null;
  if (/^#+[ \t]+\*?\*?WI-/.test(line)) rest = line.replace(/^#+[ \t]+\*?\*?/, "");
  else if (/^\|[ \t]*WI-/.test(line)) rest = line.replace(/^\|[ \t]*/, "");
  else if (/^([-*+][ \t]+)?\*\*WI-/.test(line)) {
    const after = line.replace(/^([-*+][ \t]+)?\*\*/, "");
    const m = id.exec(after);
    // A declaration closes the bold right after the id or dashes it from its title.
    if (m && (after.slice(m[0].length).startsWith("**") || /^[ \t]+(—|–|- )/.test(after.slice(m[0].length)))) rest = after;
  }
  return rest === null ? null : (id.exec(rest)?.[0] ?? null);
}

/** `{ phases: [{ id, line, wis: [{ id, noTest }] }], orphans: [{ id, line }] }` for a plan's text. */
export function parsePlan(text) {
  const phases = [];
  const orphans = [];
  let current = null;
  let wave = null;
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^[ \t]*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const id = declaredId(line);
    if (id) {
      if (!current && wave) { current = { id: wave.id, line: wave.line, wis: [] }; phases.push(current); }
      const marker = /\[no-test:([^\]]*)\]/.exec(line);
      const noTest = marker ? marker[1].trim() : null;
      if (current) current.wis.push({ id, noTest: noTest === "" ? null : noTest });
      else orphans.push({ id, line: i + 1 });
      return;
    }
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (!heading) return;
    const phase = heading[1].length === 4 ? /^Phase[ \t]+(\S+)[ \t]+—/.exec(heading[2]) : null;
    const waveHead = heading[1].length === 3 ? /^Wave[ \t]+(\d+)\b/.exec(heading[2]) : null;
    current = phase ? { id: phase[1], line: i + 1, wis: [] } : null;
    if (current) phases.push(current);
    wave = waveHead ? { id: `Wave${waveHead[1]}`, line: i + 1 } : null;
  });
  return { phases, orphans };
}

/** The work items inside a parenthesised group of a commit message — the tag form linkage accepts. */
export function taggedIds(message) {
  return new Set((message.match(/\([^)]*WI-[^)]*\)/g) ?? []).flatMap((group) => group.match(WI_ANYWHERE) ?? []));
}

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

/**
 * `Map<wi, Set<file>>` of tests a tagged commit in `range` added, modified or
 * renamed into. A file a LATER commit in the range moved is reported at its
 * new path — the module-folder moves relocated tests whose work items landed
 * earlier, and the test is the same test.
 */
function commitEvidence(root, range) {
  const out = new Map();
  const renames = new Map();
  const log = git(root, "log", "--format=%x1e%B%x1f", "--name-status", "-M", range);
  for (const entry of log.split("\x1e").slice(1)) {
    const [message, files = ""] = entry.split("\x1f");
    const ids = taggedIds(message);
    for (const row of files.split("\n")) {
      const cols = row.split("\t");
      if (/^R/.test(cols[0] ?? "")) renames.set(cols[1], cols[2]);
      if (ids.size === 0 || !/^[AMR]/.test(cols[0] ?? "")) continue;
      const file = cols.at(-1);
      if (!isTestFile(file)) continue;
      for (const id of ids) (out.get(id) ?? out.set(id, new Set()).get(id)).add(file);
    }
  }
  const current = (file) => {
    const seen = new Set();
    let at = file;
    while (!existsSync(path.join(root, at)) && renames.has(at) && !seen.has(at)) { seen.add(at); at = renames.get(at); }
    return at;
  };
  return new Map([...out].map(([id, files]) => [id, new Set([...files].map(current))]));
}

/** `Map<wi, Set<file>>` of test files whose first lines name the item. */
function headerEvidence(root, files) {
  const out = new Map();
  for (const file of files) {
    const head = readFileSync(path.join(root, file), "utf8").split("\n", HEADER_LINES).join("\n");
    for (const id of new Set(head.match(WI_ANYWHERE) ?? [])) (out.get(id) ?? out.set(id, new Set()).get(id)).add(file);
  }
  return out;
}

const REPO = path.resolve(import.meta.dirname, "..");
const TIERS = [
  ["vitest.config.ts", "."], ["vitest.gates.config.ts", "."], ["vitest.browser.config.ts", "."],
  ["vitest.soak.config.ts", "."], ["server/mcp/vitest.config.ts", "server/mcp"], ["server/content/vitest.config.ts", "server/content"],
];

/** Every file a vitest tier collects in the tree under `root`, repo-relative. */
async function collectedByVitest(root) {
  const real = realpathSync(root);
  const runs = TIERS.filter(([, dir]) => existsSync(path.join(root, dir))).map(([config, dir]) => new Promise((resolve, reject) => {
    const child = spawn(path.join(REPO, "node_modules/.bin/vitest"),
      ["list", "--filesOnly", "--json", "--config", path.join(REPO, config), "--root", path.join(real, dir)], { cwd: real });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      // `vitest list` exits 1 when a tier matches nothing; an empty tier is an answer.
      const text = stdout.trim();
      if (code === 1 && (text === "" || text === "[]") && /No test files found/i.test(stdout + stderr)) return resolve([]);
      if (code !== 0) return reject(new Error(`vitest list --config ${config} exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`));
      try { resolve(JSON.parse(text || "[]").map((e) => path.relative(real, e.file).split(path.sep).join("/"))); }
      catch (error) { reject(new Error(`vitest list --config ${config} printed no JSON: ${error.message}`)); }
    });
  }));
  return new Set((await Promise.all(runs)).flat());
}

function stateOf(root, file, collected) {
  if (!existsSync(path.join(root, file))) return "missing";
  if (file.endsWith(".test.rs")) return "cargo";
  if (file.startsWith("e2e/journeys/")) return "journey";
  return collected.has(file) ? "vitest" : "uncollected";
}

async function main([root, planPath, range]) {
  if (!root || !planPath || !range) throw new Error("usage: repo-audit-evidence.mjs <root> <plan> <git range>");
  const plan = parsePlan(readFileSync(path.join(root, planPath), "utf8"));
  const tracked = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")
    .filter((f) => f && isTestFile(f) && existsSync(path.join(root, f)));
  const byHeader = headerEvidence(root, tracked);
  const byCommit = commitEvidence(root, range);
  const collected = await collectedByVitest(root);
  const rows = [];
  for (const phase of plan.phases) {
    rows.push(["PHASE", phase.id, phase.line]);
    for (const wi of phase.wis) {
      rows.push(["WI", phase.id, wi.id, wi.noTest ?? ""]);
      for (const [source, map] of [["header", byHeader], ["commit", byCommit]]) {
        for (const file of [...(map.get(wi.id) ?? [])].sort()) rows.push(["EVIDENCE", wi.id, source, file, stateOf(root, file, collected)]);
      }
    }
  }
  for (const o of plan.orphans) rows.push(["ORPHAN", o.id, o.line]);
  process.stdout.write(rows.map((r) => r.join("\t")).join("\n") + "\n");
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`repo-audit-evidence: ${error.message}`);
    process.exit(2);
  });
}
