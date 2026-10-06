#!/usr/bin/env node
/**
 * Decision-record reference gate — an id a tracked file cites must name a
 * record a clone can read.
 *
 * Rules, comments and docs cite decisions by id. For months the records behind
 * those ids lived in a gitignored directory, so the ids were folklore: the
 * citation read as documentation and resolved to nothing. The records are now
 * tracked under `.claude/adr/`, and this gate keeps a citation from outliving
 * its record again.
 *
 * Two id spaces, told apart by shape:
 *   - repository-wide — exactly three digits. Resolves to the file
 *     `.claude/adr/<id>-<slug>.md`, whose first line must be the heading for
 *     that same id.
 *   - plan-scoped — anything else the grammar accepts (one or two digits, an
 *     optional prefix of up to three capitals, an optional lowercase suffix).
 *     These are local to the plan that made them, so the same id exists in
 *     several plans. Resolves when at least one file under
 *     `.claude/adr/plans/` or `.claude/tdd-guardian/` DEFINES it: a heading, a
 *     bold bullet or a bold paragraph that starts with the id.
 *
 * What it cannot see: WHICH plan a bare plan-scoped citation means. It proves
 * the id is defined somewhere a clone can read, not that the reader will pick
 * the right plan; the citing comment has to name its feature for that.
 * Placeholders (an id made of letters only) and lowercase or unhyphenated
 * spellings are outside the grammar and are not checked.
 *
 * It also holds the record directory itself: a record's heading carries its
 * own number, no number is claimed twice, every record and plan file is linked
 * from `.claude/adr/README.md`, and a plan file's `Defines:` line lists exactly
 * the ids it defines. A tree with no records at all fails rather than passing
 * with nothing to resolve against.
 *
 * Reads what git would publish — tracked files plus untracked ones that are not
 * ignored — so maintainer-local directories are never a finding.
 *
 * Usage: node scripts/check-adr-refs.mjs [--report] [--root=<dir>]
 *   exit 0  every citation resolves and the record directory is consistent
 *   exit 1  an unresolved citation, an inconsistent record, or an unreadable tree
 *   exit 64 bad invocation
 *
 * @coordinates-with .claude/adr/README.md — the index this gate requires
 * @coordinates-with scripts/check-adr-refs.test.mjs — the self-test
 * @module scripts/check-adr-refs
 */
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/isMainModule.mjs";

const USAGE = "Usage: node scripts/check-adr-refs.mjs [--report] [--root=<dir>]";
export const RECORD_DIR = ".claude/adr";
const PLAN_DIRS = [`${RECORD_DIR}/plans/`, ".claude/tdd-guardian/"];
const INDEX = `${RECORD_DIR}/README.md`;

const ID = "ADR-[A-Z]{0,3}\\d+[a-z]?";
const CITATION = new RegExp(`(?<![A-Za-z0-9])(${ID})(?![A-Za-z0-9])`, "g");
const DEFINITION = new RegExp(`^(?:#{2,6} |- \\*\\*|\\*\\*)(${ID})(?=\\s*[:(—–]|\\s+-\\s|\\s+AMENDMENT|\\*\\*)`);
const RECORD_FILE = /^ADR-(\d{3})-[^/]+\.md$/;

/** Every id cited in `text`, in order, with its 1-based line. */
export function extractCitations(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(CITATION)) out.push({ id: m[1], line: i + 1 });
  }
  return out;
}

/** Whether `id` belongs to the repository-wide space (exactly three digits). */
export function isRepoWideId(id) {
  return /^ADR-\d{3}$/.test(id);
}

/** The ids a plan file defines: definition lines outside fenced code. */
export function definedIds(text) {
  const ids = new Set();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = DEFINITION.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Parse argv; throws on an unknown flag or a `--root` that is not a directory. */
export function parseArgs(argv, defaultRoot) {
  const opts = { report: false, root: defaultRoot };
  for (const a of argv) {
    if (a === "--report") opts.report = true;
    else if (a.startsWith("--root=")) {
      const raw = a.slice("--root=".length);
      // `path.resolve("")` is the working directory: a bare `--root=` would scan
      // wherever the caller stands instead of the tree it meant to name.
      if (raw.trim() === "") throw new Error(`--root= needs a directory path\n${USAGE}`);
      opts.root = path.resolve(raw);
    } else throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
  }
  if (!statSync(opts.root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`--root is not a directory: ${opts.root}\n${USAGE}`);
  }
  return opts;
}

/** Repo-relative paths git would publish from `root`. */
function listFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.split("\0").filter((f) => f !== "");
}

/** File text, or null for a missing file, a non-file, or a binary one. */
function readText(file) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  const head = Buffer.alloc(8000);
  const fd = openSync(file, "r");
  let n;
  try {
    n = readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (head.subarray(0, n).includes(0)) return null;
  return readFileSync(file, "utf8");
}

/** Read the record directory: what resolves, and what is wrong with it. */
function loadRegistry(root, files, texts) {
  const problems = [];
  const repoWide = new Map();
  const planScoped = new Set();
  const indexed = [];
  for (const file of files) {
    const text = texts.get(file);
    if (text == null) continue;
    const inRecordDir = path.posix.dirname(file) === RECORD_DIR;
    const name = path.posix.basename(file);
    const rec = inRecordDir ? RECORD_FILE.exec(name) : null;
    if (rec) {
      indexed.push(file);
      const id = `ADR-${rec[1]}`;
      if (!new RegExp(`^# ${id}(?!\\d)`).test(text)) {
        problems.push(`${file}: the first line is not the heading for ${id}`);
      }
      if (repoWide.has(id)) problems.push(`${file}: two records claim ${id} (also ${repoWide.get(id)})`);
      else repoWide.set(id, file);
    } else if (PLAN_DIRS.some((d) => file.startsWith(d)) && file.endsWith(".md")) {
      const defined = definedIds(text);
      for (const id of defined) planScoped.add(id);
      if (file.startsWith(PLAN_DIRS[0])) {
        indexed.push(file);
        const line = text.split("\n").find((l) => l.startsWith("> Defines:"));
        const declared = new Set(line ? extractCitations(line).map((c) => c.id) : []);
        const extra = [...declared].filter((id) => !defined.has(id));
        const missing = [...defined].filter((id) => !declared.has(id));
        if (!line) problems.push(`${file}: no "> Defines:" line`);
        else if (extra.length || missing.length) {
          problems.push(
            `${file}: Defines line disagrees with the definitions below it` +
              (extra.length ? ` — lists ${extra.join(", ")} without defining` : "") +
              (missing.length ? ` — defines ${missing.join(", ")} without listing` : ""),
          );
        }
      }
    }
  }
  if (repoWide.size === 0) {
    problems.push(`${RECORD_DIR}/: no decision records found — the gate has nothing to resolve against`);
    return { repoWide, planScoped, problems };
  }
  const index = texts.get(INDEX);
  if (index == null) problems.push(`${INDEX}: missing — it is the index every record must be linked from`);
  else {
    for (const file of indexed) {
      const rel = path.posix.relative(RECORD_DIR, file);
      if (!index.includes(`(${rel})`)) problems.push(`${file}: not linked from ${INDEX}`);
    }
  }
  return { repoWide, planScoped, problems };
}

/** Scan `root`: unresolved citations, record-directory problems, and counts. */
export function collect(root) {
  const files = listFiles(root);
  const texts = new Map();
  for (const file of files) {
    const text = readText(path.join(root, file));
    if (text != null) texts.set(file, text);
  }
  const { repoWide, planScoped, problems } = loadRegistry(root, files, texts);
  const findings = [];
  const counts = new Map();
  let total = 0;
  for (const [file, text] of texts) {
    if (!text.includes("ADR-")) continue;
    for (const { id, line } of extractCitations(text)) {
      total++;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const ok = isRepoWideId(id) ? repoWide.has(id) : planScoped.has(id);
      if (ok) continue;
      findings.push({
        file,
        line,
        id,
        reason: isRepoWideId(id)
          ? `no ${RECORD_DIR}/${id}-*.md`
          : `no file under ${PLAN_DIRS.join(" or ")} defines it`,
      });
    }
  }
  return { findings, problems, stats: { files: texts.size, total, counts, records: repoWide.size, planScoped: planScoped.size } };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), path.resolve(import.meta.dirname, ".."));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(64);
  }
  let result;
  try {
    result = collect(opts.root);
  } catch (error) {
    console.error(`❌ Cannot scan decision-record references under ${opts.root}: ${error.message}`);
    process.exit(1);
  }
  const { findings, problems, stats } = result;
  if (opts.report) {
    const rows = [...stats.counts].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }));
    for (const [id, n] of rows) console.log(`  ${id.padEnd(12)} ${n}`);
  }
  if (problems.length > 0) {
    console.error(`\n❌ ${problems.length} problem(s) in ${RECORD_DIR}/:\n`);
    for (const p of problems) console.error(`   ${p}`);
  }
  if (findings.length > 0) {
    console.error(`\n❌ ${findings.length} decision-record citation(s) do not resolve:\n`);
    for (const f of findings) console.error(`   ${f.file}:${f.line}  ${f.id}  (${f.reason})`);
    console.error(
      `\n   Add the record under ${RECORD_DIR}/ (see ${INDEX}), or — when no record\n` +
        "   ever existed — replace the citation with the behaviour it stood for.\n",
    );
  }
  if (problems.length > 0 || findings.length > 0) process.exit(1);
  console.log(
    `✅ ${stats.total} citation(s) in ${stats.files} file(s) resolve to ${stats.records} record(s) and ${stats.planScoped} plan-scoped id(s).`,
  );
}

if (isMainModule(import.meta.url)) main();
