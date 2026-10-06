#!/usr/bin/env -S node --import tsx
/**
 * Markdown Documentation Translation Script
 *
 * Translates VitePress markdown pages in website/ to supported languages
 * using the Anthropic Claude API.
 *
 * Usage:
 *   tsx scripts/translate-docs.ts --lang zh-CN
 *   tsx scripts/translate-docs.ts --lang zh-CN --file guide/features.md
 *   tsx scripts/translate-docs.ts --lang all
 *   tsx scripts/translate-docs.ts --lang zh-CN --dry-run
 *   tsx scripts/translate-docs.ts --lang zh-CN --force
 *
 * Options:
 *   --lang <code|all>       BCP-47 language code or "all" for all languages
 *   --file <path>           Translate a single file only (relative to website/)
 *   --dry-run               Show what would be translated without writing files
 *   --force                 Retranslate even if target file already exists
 *
 * Environment:
 *   ANTHROPIC_API_KEY       Required — your Anthropic API key
 *
 * The work lives in scripts/translate-docs/; this file is the CLI.
 *
 * @coordinates-with scripts/translate-docs/jobs.ts — job list and execution
 * @coordinates-with scripts/translate-docs/translateFile.ts — one page through the API
 */

import { buildJobs, runJob } from "./translate-docs/jobs.js";
import { LANGUAGES, type CliArgs, type JobResult, type TranslationJob } from "./translate-docs/model.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);

  function getArg(name: string): string | undefined {
    const idx = argv.indexOf(name);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  }

  function hasFlag(name: string): boolean {
    return argv.includes(name);
  }

  const lang = getArg("--lang");
  if (!lang) {
    throw new Error('Missing required argument: --lang <code|all>');
  }

  const file = getArg("--file") ?? null;

  return {
    lang,
    file,
    dryRun: hasFlag("--dry-run"),
    force: hasFlag("--force"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("");
    console.error("Usage:");
    console.error("  tsx scripts/translate-docs.ts --lang zh-CN");
    console.error("  tsx scripts/translate-docs.ts --lang zh-CN --file guide/features.md");
    console.error("  tsx scripts/translate-docs.ts --lang all");
    console.error("  tsx scripts/translate-docs.ts --lang zh-CN --dry-run");
    console.error("  tsx scripts/translate-docs.ts --lang zh-CN --force");
    console.error("");
    console.error(`Supported languages: ${Object.keys(LANGUAGES).join(", ")}`);
    process.exit(1);
  }

  // Check API key early (not needed for dry-run, but catch it up front)
  if (!args.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("Export it before running: export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  let jobs: TranslationJob[];
  try {
    jobs = buildJobs(args);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Header
  const langDisplay =
    args.lang === "all"
      ? `all (${Object.keys(LANGUAGES).join(", ")})`
      : `${args.lang} — ${LANGUAGES[args.lang] ?? args.lang}`;

  console.log("\nVMark Documentation Translation");
  console.log(`  Language : ${langDisplay}`);
  if (args.file) console.log(`  File     : ${args.file}`);
  console.log(`  Files    : ${jobs.length} job(s)`);
  if (args.dryRun) console.log("  Mode     : DRY RUN (no files will be written)");
  if (args.force) console.log("  Force    : yes (overwrite existing translations)");
  console.log("");

  const results: JobResult[] = [];

  for (let i = 0; i < jobs.length; i++) {
    const result = await runJob(jobs[i]!, { dryRun: args.dryRun, force: args.force }, i, jobs.length);
    results.push(result);
  }

  // Summary
  const translated = results.filter((r) => r.status === "translated").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const dryRun = results.filter((r) => r.status === "dry-run").length;
  const errors = results.filter((r) => r.status === "error").length;

  console.log("");
  console.log("Summary:");
  if (translated > 0) console.log(`  Translated : ${translated} file(s)`);
  if (skipped > 0) console.log(`  Skipped    : ${skipped} file(s) (already exist)`);
  if (dryRun > 0) console.log(`  Would translate: ${dryRun} file(s)`);
  if (errors > 0) {
    console.log(`  Errors     : ${errors} file(s)`);
    console.error("\nFailed files:");
    results
      .filter((r) => r.status === "error")
      .forEach((r) => console.error(`  - ${r.lang}/${r.relPath}: ${r.error}`));
    process.exit(1);
  }
}

main();
