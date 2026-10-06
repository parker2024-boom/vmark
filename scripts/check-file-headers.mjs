#!/usr/bin/env node
/**
 * File-header gate — every production TypeScript file under `src/` opens with
 * the header rule 22 defines.
 *
 * Three header grammars used to coexist (`/**` with `@module`, `/**` with only
 * `Purpose:`, a run of `//` lines) and about one file in seven had none, so a
 * reader could not rely on any file saying what it is for, and `@module` — the
 * tag the header-reference gate checks — was missing from one file in five.
 * The grammar is in `scripts/lib/fileHeaders.mjs`; this CLI runs it over the
 * tree. There is no baseline: the tree carries zero findings.
 *
 * Usage: node scripts/check-file-headers.mjs [--root=<dir>]
 *   exit 0  every subject file carries a conforming header
 *   exit 1  at least one does not (each problem is listed)
 *   exit 64 bad invocation
 *
 * @coordinates-with scripts/lib/fileHeaders.mjs — the grammar
 * @coordinates-with scripts/check-file-headers.test.mjs — the self-test
 * @coordinates-with .claude/rules/22-comment-maintenance.md — the rule this enforces
 * @module scripts/check-file-headers
 */
import { statSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/isMainModule.mjs";
import { scanHeaders } from "./lib/fileHeaders.mjs";

const USAGE = "Usage: node scripts/check-file-headers.mjs [--root=<dir>]";

/** Parse argv; throws on an unknown flag or a `--root` that is not a directory. */
export function parseArgs(argv, defaultRoot) {
  const opts = { root: defaultRoot };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let raw = null;
    if (a.startsWith("--root=")) raw = a.slice("--root=".length);
    else if (a === "--root" && i + 1 < argv.length) raw = argv[++i];
    else throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    // An empty --root would resolve to the CWD and silently scan the wrong tree.
    if (raw.trim() === "") throw new Error(`--root needs a directory path\n${USAGE}`);
    opts.root = path.resolve(raw);
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
  let result;
  try {
    result = scanHeaders(opts.root);
  } catch (error) {
    console.error(`❌ Cannot scan file headers under ${opts.root}: ${error.message}`);
    process.exit(1);
  }
  const { files, findings } = result;
  // A scan that found nothing to check is a broken scan, not a clean tree.
  if (files === 0) {
    console.error(`❌ File headers: no subject files found under ${opts.root} — the scan is pointed at the wrong tree.`);
    process.exit(1);
  }
  if (findings.length === 0) {
    console.log(`✅ File headers: ${files} production file(s) under src/, every one opens with its header and a correct @module.`);
    return;
  }
  const byFile = new Set(findings.map((f) => f.file)).size;
  console.error(`\n❌ ${findings.length} header problem(s) in ${byFile} file(s):\n`);
  for (const f of findings) console.error(`   ${f.file}\n       ${f.problem}`);
  console.error(
    "\n   Every production .ts/.tsx under src/ opens with a /** … */ block that says what the\n" +
      "   file is for, ends with `@module <path under src/, no extension>`, and is followed by a\n" +
      "   blank line (rule 22, .claude/rules/22-comment-maintenance.md).\n",
  );
  process.exit(1);
}

if (isMainModule(import.meta.url)) main();
