#!/usr/bin/env node
/**
 * `Result<T, String>` command ratchet.
 *
 * Rule 50 §10 used to canonize `Result<T, String>` for every Tauri command, so
 * the only thing that crossed the IPC boundary was prose. The frontend then
 * recovered the failure class by matching TEXT — a `"PARENT_MISSING:"` prefix
 * in the save path, `String(error).includes("APPROVAL_REQUIRED")` in the MCP
 * browser handlers — and ~370 raw-English `format!` sites stayed invisible to
 * `lint:i18n`. `CommandError` (`src-tauri/src/command_error.rs`) replaces it.
 *
 * A crate-wide migration lands over many PRs, and the C1 lesson is that one
 * without a ratchet stalls at "some of it". So: a per-file count of the
 * remaining legacy signatures, frozen at today's reality, two-way (house
 * standard) — a NEW legacy command fails the gate, and a file that improved
 * fails until the win is written down, because an unrecorded win is silent
 * headroom for the next regression.
 *
 * Counting is a real Rust lex, not a regex over raw text: comments and string
 * literals must not count (the baseline would be unfalsifiable), and a plain
 * `fn` returning `Result<T, String>` must not count (ordinary Rust is not this
 * gate's business).
 *
 * The lex is `scripts/lib/rustSource.mjs`'s, not a second copy. This file
 * carried its own `stripCommentsAndStrings`, and it had already DRIFTED from
 * the shared one in both directions a duplicated lexer drifts: it capped
 * raw-string delimiter detection at a 16-character slice (Rust allows 255
 * hashes, so a longer one was mis-tokenised as code) and
 * it had never heard of the C string literals `c"…"` / `cr#"…"#` stable since
 * Rust 1.77. Two lexers over one language is the defect; there is one now.
 *
 * The attribute is matched with BALANCED arguments, not as the exact string
 * `#[tauri::command]`: `#[tauri::command(rename_all = "snake_case")]` and
 * `#[tauri::command(async)]` are the same attribute, and an exact-string match
 * made every parameterized command invisible to the ratchet.
 *
 * The return type is matched with its PATH NORMALIZED, so
 * `std::result::Result<_, String>` and `Result<_, ::std::string::String>` count
 * exactly as the bare spelling does.
 *
 * TYPE ALIASES ARE RESOLVED, crate-wide. `type CmdResult<T> = Result<T,
 * String>;` followed by `-> CmdResult<u8>` used to be a legacy signature this
 * gate could not see, and the header said so — which made the documented
 * limitation a documented BYPASS: adding one alias would have taken every
 * future legacy command off the ratchet's books while it reported green. Full
 * name resolution needs `syn`; naming the aliases does not. Every `type X<…> =
 * …;` in the crate is collected and the set that expands (transitively) to
 * `Result<_, String>` counts exactly as the bare spelling does. Measured at
 * zero aliases today, so nothing about the current count changes — the point
 * is that introducing one now fails the gate instead of silencing it.
 *
 * Usage:
 *   node scripts/check-command-error-ratchet.mjs [--root <dir>] [--baseline <file>]
 *   node scripts/check-command-error-ratchet.mjs --write-baseline
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isMainModule } from "./lib/isMainModule.mjs";
import { scanCrate } from "./lib/commandErrorRatchet/rustCommands.mjs";
import { scanStringifiedTypedErrors } from "./lib/commandErrorRatchet/stringifiedErrors.mjs";

// The counting and the frontend scan live in scripts/lib/commandErrorRatchet/;
// re-exported so this gate's importers keep one entry point.
export {
  commandAttributeEnds,
  countLegacyCommands,
  isLegacyStringResult,
  legacyResultAliases,
  scanCrate,
  typeAliases,
  typedCommandNames,
} from "./lib/commandErrorRatchet/rustCommands.mjs";
export {
  findStringifiedTypedErrors,
  scanStringifiedTypedErrors,
} from "./lib/commandErrorRatchet/stringifiedErrors.mjs";

// ─── Pure, testable core ───

/** Fail loudly on malformed baseline data — never read a bad file as "empty". */
export function validateBaseline(raw, label) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label}: expected a JSON object with a "files" map`);
  }
  const files = raw.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`${label}: "files" must be an object of {path: count}`);
  }
  for (const [file, count] of Object.entries(files)) {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(
        `${label}: count for ${file} must be a positive integer, got ${JSON.stringify(count)}`,
      );
    }
  }
  return files;
}

/** Two-way per-file comparison. */
export function compareCounts(actual, baseline) {
  const raised = [];
  const lowered = [];
  const gone = [];
  for (const [file, count] of Object.entries(actual)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) raised.push({ file, count, allowed });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = actual[file];
    if (count === undefined) gone.push({ file, allowed });
    else if (count < allowed) lowered.push({ file, count, allowed });
  }
  return { raised, lowered, gone };
}

// ─── CLI shell ───

const BASELINE_HEADER = [
  "Remaining `Result<T, String>` #[tauri::command] signatures per file — the WI-14 CommandError migration ratchet.",
  "Checked by scripts/check-command-error-ratchet.mjs (pnpm lint:command-errors, in check:all).",
  "Two-way: a NEW legacy signature fails the gate, and a file that improved fails until its number is lowered here — an unrecorded win is silent headroom for the next regression.",
  "Numbers only go DOWN. Migrate the command to Result<T, CommandError> (see .claude/rules/50-codebase-conventions.md §10), then lower or delete its entry.",
  "Registered in the WI-16 ratchet manifest (scripts/check-baseline-ratchet.mjs), which re-compares this file against the merge base in CI — so a commit cannot raise its own floor.",
];

/**
 * Parse argv, or throw with the message to print.
 *
 * A value-taking flag MUST be followed by a value. `--root` with nothing after
 * it read `argv[++i]` as `undefined` and then fell through to `args.root ??
 * <default>` — so a mistyped invocation silently scanned the repository the
 * script lives in rather than the tree the caller named, and reported a verdict
 * about the wrong tree. A following `--flag` is the same
 * mistake spelled differently, so it is refused too.
 */
export function parseArgs(argv) {
  const args = { root: null, baseline: null, write: false };
  const value = (flag, i) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${flag} needs a value (got ${next === undefined ? "nothing" : JSON.stringify(next)})`);
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = value("--root", i++);
    else if (argv[i] === "--baseline") args.baseline = value("--baseline", i++);
    else if (argv[i] === "--write-baseline") args.write = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    console.error(
      "   Usage: node scripts/check-command-error-ratchet.mjs [--root <dir>] [--baseline <file>] [--write-baseline]",
    );
    process.exit(1);
  }
  const root = path.resolve(
    args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const baselinePath = path.resolve(
    args.baseline ?? path.join(root, "scripts", "command-error-baseline.json"),
  );

  const { counts: actual, typed } = scanCrate(root);
  const total = Object.values(actual).reduce((sum, n) => sum + n, 0);

  if (args.write) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ "//": BASELINE_HEADER, files: actual }, null, 2) + "\n",
    );
    console.log(`✍️  Wrote ${total} remaining legacy command(s) to ${baselinePath}`);
    return;
  }

  let baseline;
  try {
    baseline = validateBaseline(JSON.parse(readFileSync(baselinePath, "utf8")), baselinePath);
  } catch (error) {
    console.error(`❌ Cannot read the command-error baseline (${baselinePath}): ${error.message}`);
    console.error("   The gate fails closed — fix the baseline, never delete it to pass.");
    process.exit(1);
  }

  const { raised, lowered, gone } = compareCounts(actual, baseline);

  const stringified = scanStringifiedTypedErrors(root, typed);

  if (raised.length === 0 && lowered.length === 0 && gone.length === 0 && stringified.length === 0) {
    console.log(
      `✅ CommandError ratchet held (${total} legacy Result<T, String> command(s) remain, none added).`,
    );
    return;
  }

  if (stringified.length > 0) {
    console.error(
      `\n❌ ${stringified.length} frontend file(s) render a TYPED command's error with String():\n`,
    );
    for (const { file, command } of stringified) console.error(`   ${file} — invokes ${command}`);
    console.error(
      "\n   A CommandError is a plain object, so String(error) renders the literal\n" +
        '   "[object Object]". Use commandErrorMessage() (rule 50 §10). This shipped\n' +
        "   to users at four boundaries before WI-DP2.6 caught it by hand.",
    );
  }

  if (raised.length > 0) {
    console.error(`\n❌ ${raised.length} file(s) gained a legacy Result<T, String> command:\n`);
    for (const { file, count, allowed } of raised) {
      console.error(`   ${file} — ${count} found, ${allowed} allowed`);
    }
    console.error(
      "\n   New commands return Result<T, CommandError> (rule 50 §10). The frontend\n" +
        "   branches on `code`; a String forces it back to matching message text.",
    );
  }

  if (lowered.length > 0) {
    console.error(`\n❌ ${lowered.length} file(s) improved — record the win:\n`);
    for (const { file, count, allowed } of lowered) {
      console.error(`   ${file} — ${count} found, baseline still says ${allowed}`);
    }
  }

  if (gone.length > 0) {
    console.error(`\n❌ ${gone.length} baselined file(s) no longer have legacy commands:\n`);
    for (const { file, allowed } of gone) console.error(`   ${file} — baseline says ${allowed}`);
    console.error("\n   Delete these entries so the improvement cannot become headroom.");
  }

  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main();
}
