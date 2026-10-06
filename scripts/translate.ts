#!/usr/bin/env -S node --import tsx
/**
 * AI Translation Script
 *
 * Translates i18n locale files using the Anthropic Claude API.
 *
 * Usage (JSON namespace files):
 *   npx tsx scripts/translate.ts --source src/locales/en --target src/locales/zh-CN --lang zh-CN
 *
 * Usage (YAML Rust locale file):
 *   npx tsx scripts/translate.ts --source src-tauri/locales/en.yml --target src-tauri/locales/zh-CN.yml --lang zh-CN --format yaml
 *
 * Options:
 *   --source <path>    Source directory (JSON) or file (YAML)
 *   --target <path>    Target directory (JSON) or file (YAML)
 *   --lang <code>      BCP-47 language code (e.g. zh-CN, ja, fr)
 *   --format yaml      Treat source/target as single YAML files (Rust locale)
 *   --dry-run          Show what would be translated without writing files
 *   --force            Translate even if target file already exists and is up-to-date
 *
 * Environment:
 *   ANTHROPIC_API_KEY  Required — your Anthropic API key
 *
 * The script is diff-aware: it computes a SHA-256 hash of the source content
 * and stores it in a sidecar file (.translate-hash) next to each translated
 * file.  On subsequent runs it skips files whose source hash has not changed
 * since the last successful translation.
 *
 * The work lives in scripts/translate/; this file is the CLI.
 *
 * @coordinates-with scripts/translate/files.ts — directory and file translation
 * @coordinates-with scripts/translate/translateContent.ts — prompts and validation
 */

import {
  translateJsonDirectory,
  translateYamlFile,
  type CliArgs,
  type TranslationResult,
} from "./translate/files.js";
import { getLanguageName } from "./translate/translateContent.js";

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

  const source = getArg("--source");
  const target = getArg("--target");
  const lang = getArg("--lang");

  if (!source) {
    throw new Error("Missing required argument: --source <path>");
  }
  if (!target) {
    throw new Error("Missing required argument: --target <path>");
  }
  if (!lang) {
    throw new Error("Missing required argument: --lang <code>");
  }

  const formatArg = getArg("--format");
  const format = formatArg === "yaml" ? "yaml" : "json";

  return {
    source,
    target,
    lang,
    format,
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
    console.error(
      "  npx tsx scripts/translate.ts --source src/locales/en --target src/locales/zh-CN --lang zh-CN"
    );
    console.error(
      "  npx tsx scripts/translate.ts --source src-tauri/locales/en.yml --target src-tauri/locales/zh-CN.yml --lang zh-CN --format yaml"
    );
    process.exit(1);
  }

  const langName = getLanguageName(args.lang);
  console.log(`\nVMark i18n Translation`);
  console.log(`  Language : ${args.lang} — ${langName}`);
  console.log(`  Source   : ${args.source}`);
  console.log(`  Target   : ${args.target}`);
  console.log(`  Format   : ${args.format}`);
  if (args.dryRun) console.log(`  Mode     : DRY RUN (no files will be written)`);
  if (args.force) console.log(`  Force    : yes (ignoring cached hashes)`);
  console.log("");

  try {
    let results: TranslationResult[];

    if (args.format === "yaml") {
      results = await translateYamlFile(args);
    } else {
      results = await translateJsonDirectory(args);
    }

    // Summary
    const translated = results.filter((r) => r.status === "translated").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const dryRun = results.filter((r) => r.status === "dry-run").length;

    console.log("");
    console.log(`Summary:`);
    if (translated > 0) console.log(`  Translated : ${translated} file(s)`);
    if (skipped > 0) console.log(`  Skipped    : ${skipped} file(s) (up-to-date)`);
    if (dryRun > 0) console.log(`  Would translate: ${dryRun} file(s)`);
  } catch (err) {
    console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
