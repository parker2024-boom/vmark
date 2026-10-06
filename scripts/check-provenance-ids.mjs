#!/usr/bin/env node
/**
 * Provenance-id gate — a production comment that cites a work item or an
 * audit must cite one a fresh clone can find.
 *
 * Comments in `src/`, `src-tauri/src/`, `server/`, `e2e/` and the tooling
 * (`scripts/`, `.claude/hooks/`, shell scripts included) used to carry
 * about two thousand `WI-<id>` ids and several hundred audit citations, most of
 * them pointing into maintainer-local plans that no clone has — and some of
 * them, read against the tracked plans, pointing at an unrelated item that
 * shares the number. The reason a line exists has to be readable without a
 * lookup that may fail, so the comment states the behavioural reason and the
 * id goes, unless it resolves (the rules are in `scripts/lib/provenanceIds.mjs`).
 *
 * Offline and deterministic: the verdict depends on the checkout alone (tracked
 * plans under `.claude/tdd-guardian/` and `.claude/adr/plans/`, audit records
 * under `.cc-suite/audits/` and `.claude/tdd-guardian/`), never on the network
 * or on how much history was cloned. Issue numbers are not checked.
 *
 * Two citations a clone can never follow are refused outright, over the same
 * trees (rules in `scripts/lib/commentCitations.mjs`): a
 * calendar date, which says when instead of what was observed, and a path to a
 * document under the gitignored `dev-docs/`. There is no baseline: the tree
 * carries zero findings of any kind.
 *
 * Usage: node scripts/check-provenance-ids.mjs [--report] [--root=<dir>]
 *   exit 0  every WI and audit token resolves, and no comment carries a date or a dev-docs document path
 *   exit 1  at least one finding (each is listed with its reason)
 *   exit 64 bad invocation
 *
 * @coordinates-with scripts/lib/provenanceIds.mjs — the token grammar and resolution rules
 * @coordinates-with scripts/lib/commentCitations.mjs — the date and dev-docs rules
 * @coordinates-with scripts/lib/sourceComments.mjs — reads every comment of a file
 * @coordinates-with scripts/check-provenance-ids.test.mjs — the self-test
 * @coordinates-with .claude/rules/22-comment-maintenance.md — the rule this enforces
 * @module scripts/check-provenance-ids
 */
import { statSync } from "node:fs";
import path from "node:path";

import { scanCitations } from "./lib/commentCitations.mjs";
import { isMainModule } from "./lib/isMainModule.mjs";
import { scanTree } from "./lib/provenanceIds.mjs";

const USAGE = "Usage: node scripts/check-provenance-ids.mjs [--report] [--root=<dir>]";

/** Parse argv; throws on an unknown flag or a `--root` that is not a directory. */
export function parseArgs(argv, defaultRoot) {
  const opts = { report: false, root: defaultRoot };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let raw = null;
    if (a === "--report") opts.report = true;
    else if (a.startsWith("--root=")) raw = a.slice("--root=".length);
    else if (a === "--root" && i + 1 < argv.length) raw = argv[++i];
    else throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    if (raw !== null) {
      // An empty --root would resolve to the CWD and silently scan the wrong tree.
      if (raw.trim() === "") throw new Error(`--root needs a directory path\n${USAGE}`);
      opts.root = path.resolve(raw);
    }
  }
  if (!statSync(opts.root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`--root is not a directory: ${opts.root}\n${USAGE}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), path.resolve(import.meta.dirname, ".."));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(64);
  }
  let tokens;
  let citations;
  try {
    tokens = scanTree(opts.root);
    citations = scanCitations(opts.root);
  } catch (error) {
    console.error(`❌ Cannot scan production comments under ${opts.root}: ${error.message}`);
    process.exit(1);
  }
  const checked = tokens.filter((t) => t.kind !== "issue");
  const findings = checked.filter((t) => t.reason);
  if (opts.report) {
    for (const t of tokens) console.log(`${t.reason ? "DANGLING" : "resolves"}  ${t.kind.padEnd(5)}  ${t.file}:${t.line}  ${t.token}${t.reason ? ` — ${t.reason}` : ""}`);
    for (const c of citations) console.log(`REFUSED   ${c.kind.padEnd(8)}  ${c.file}:${c.line}  ${c.token}`);
  }
  const files = new Set(checked.map((t) => t.file)).size;
  if (findings.length === 0 && citations.length === 0) {
    console.log(
      `✅ Provenance ids: ${checked.length} WI/audit token(s) in ${files} production file(s), all resolve; ` +
        "no production comment carries a calendar date or a dev-docs/ document path.",
    );
    return;
  }
  if (findings.length > 0) {
    console.error(`\n❌ ${findings.length} provenance id(s) in production comments do not resolve:\n`);
    for (const f of findings) console.error(`   ${f.file}:${f.line}  ${f.token}\n       ${f.reason}`);
    console.error(
      "\n   State the behavioural reason in the comment and drop the id (rule 22). A WI id\n" +
        "   may stay only when a tracked plan defines it; an audit citation only with the\n" +
        "   date of a tracked audit record. Plans in dev-docs/ do not count: a clone cannot read them.\n",
    );
  }
  if (citations.length > 0) {
    console.error(`\n❌ ${citations.length} calendar date(s) or dev-docs/ path(s) in production comments:\n`);
    for (const c of citations) console.error(`   ${c.file}:${c.line}  ${c.token}\n       ${c.reason}`);
    console.error(
      "\n   Keep the fact, drop the when (rule 22): \"measured on <date>: X\" becomes \"measured: X\".\n" +
        "   A date inside a tracked path, or of a tracked audit record cited as `audit <date> #N`,\n" +
        "   is an identifier and stays. Cite a tracked file, not dev-docs/, which no clone has.\n",
    );
  }
  process.exit(1);
}

if (isMainModule(import.meta.url)) main();
