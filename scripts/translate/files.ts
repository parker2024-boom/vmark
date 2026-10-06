/**
 * Translates a JSON namespace directory or a single YAML locale file, skipping
 * what the hash cache says is up to date.
 *
 * @coordinates-with scripts/translate.ts — the CLI that drives this module
 * @coordinates-with scripts/translate/hashCache.ts — the skip decision
 * @coordinates-with scripts/translate/translateContent.ts — the translation
 * @module scripts/translate/files
 */
import fs from "node:fs";
import path from "node:path";

import { computeHash, isUpToDate, writeStoredHash } from "./hashCache.js";
import { translateJsonContent, translateYamlContent } from "./translateContent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliArgs {
  source: string;
  target: string;
  lang: string;
  format: "json" | "yaml";
  dryRun: boolean;
  force: boolean;
}

export interface TranslationResult {
  file: string;
  status: "translated" | "skipped" | "dry-run";
  reason?: string;
}

// ---------------------------------------------------------------------------
// JSON directory translation
// ---------------------------------------------------------------------------

export async function translateJsonDirectory(args: CliArgs): Promise<TranslationResult[]> {
  const results: TranslationResult[] = [];

  if (!fs.existsSync(args.source)) {
    throw new Error(`Source directory not found: ${args.source}`);
  }

  // Ensure target directory exists
  if (!args.dryRun) {
    fs.mkdirSync(args.target, { recursive: true });
  }

  const files = fs.readdirSync(args.source).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.warn(`Warning: no JSON files found in ${args.source}`);
  }

  for (const file of files) {
    const sourceFile = path.join(args.source, file);
    const targetFile = path.join(args.target, file);
    const sourceContent = fs.readFileSync(sourceFile, "utf-8");
    const sourceHash = computeHash(sourceContent);

    if (!args.force && isUpToDate(sourceHash, targetFile)) {
      console.log(`  [skip]   ${file} — source unchanged`);
      results.push({ file, status: "skipped", reason: "source unchanged" });
      continue;
    }

    if (args.dryRun) {
      console.log(`  [dry-run] ${file} — would translate`);
      results.push({ file, status: "dry-run" });
      continue;
    }

    console.log(`  [translate] ${file}...`);
    const translated = await translateJsonContent(sourceContent, args.lang);

    // Pretty-print to match the 2-space indent style used in the source
    const parsed = JSON.parse(translated);
    const formatted = JSON.stringify(parsed, null, 2) + "\n";

    fs.writeFileSync(targetFile, formatted, "utf-8");
    writeStoredHash(targetFile, sourceHash);

    console.log(`  [done]   ${file}`);
    results.push({ file, status: "translated" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// YAML file translation
// ---------------------------------------------------------------------------

export async function translateYamlFile(args: CliArgs): Promise<TranslationResult[]> {
  const results: TranslationResult[] = [];
  const file = path.basename(args.source);

  if (!fs.existsSync(args.source)) {
    throw new Error(`Source file not found: ${args.source}`);
  }

  const sourceContent = fs.readFileSync(args.source, "utf-8");
  const sourceHash = computeHash(sourceContent);

  if (!args.force && isUpToDate(sourceHash, args.target)) {
    console.log(`  [skip]   ${file} — source unchanged`);
    return [{ file, status: "skipped", reason: "source unchanged" }];
  }

  if (args.dryRun) {
    console.log(`  [dry-run] ${file} — would translate`);
    return [{ file, status: "dry-run" }];
  }

  // Ensure target directory exists
  fs.mkdirSync(path.dirname(args.target), { recursive: true });

  console.log(`  [translate] ${file}...`);
  const translated = await translateYamlContent(sourceContent, args.lang);

  fs.writeFileSync(args.target, translated + "\n", "utf-8");
  writeStoredHash(args.target, sourceHash);

  console.log(`  [done]   ${file}`);
  results.push({ file, status: "translated" });

  return results;
}
