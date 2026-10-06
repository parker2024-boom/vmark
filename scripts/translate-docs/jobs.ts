/**
 * Builds the translation job list from website/ and runs one job: skip an
 * existing target, report a dry run, or translate and write.
 *
 * @coordinates-with scripts/translate-docs.ts — the CLI that drives this module
 * @coordinates-with scripts/translate-docs/translateFile.ts — the translation
 * @module scripts/translate-docs/jobs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LANGUAGES, type CliArgs, type JobResult, type TranslationJob } from "./model.js";
import { translateFile } from "./translateFile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WEBSITE_DIR = path.join(REPO_ROOT, "website");

/** Directories to exclude when discovering source markdown files. */
const EXCLUDE_DIRS = new Set(["node_modules", ".vitepress", "public"]);

// ---------------------------------------------------------------------------
// Source file discovery
// ---------------------------------------------------------------------------

/**
 * Recursively find all .md files under dir, excluding EXCLUDE_DIRS and
 * any directory that looks like a locale output directory (matches a known
 * language code).
 */
function findMarkdownFiles(dir: string, base: string = dir): string[] {
  const langCodes = new Set(Object.keys(LANGUAGES));
  const results: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      // Skip locale output directories (e.g. website/zh-CN/)
      if (langCodes.has(entry.name)) continue;
      results.push(...findMarkdownFiles(path.join(dir, entry.name), base));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(base, path.join(dir, entry.name)));
    }
  }

  return results.sort();
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

export async function runJob(job: TranslationJob, opts: { dryRun: boolean; force: boolean }, index: number, total: number): Promise<JobResult> {
  const tag = `[${String(index + 1).padStart(String(total).length)}/${total}]`;
  const label = `${job.relPath} → ${job.lang}`;

  // Skip check
  if (!opts.force && fs.existsSync(job.targetPath)) {
    console.log(`${tag} Skipping ${label} (already exists)`);
    return { relPath: job.relPath, lang: job.lang, status: "skipped" };
  }

  // Dry-run check
  if (opts.dryRun) {
    console.log(`${tag} Would translate ${label}`);
    return { relPath: job.relPath, lang: job.lang, status: "dry-run" };
  }

  process.stdout.write(`${tag} Translating ${label}... `);
  const start = Date.now();

  try {
    const translated = await translateFile(job);
    const durationMs = Date.now() - start;

    // Write output
    fs.mkdirSync(path.dirname(job.targetPath), { recursive: true });
    fs.writeFileSync(job.targetPath, translated, "utf-8");

    console.log(`done (${(durationMs / 1000).toFixed(1)}s)`);
    return { relPath: job.relPath, lang: job.lang, status: "translated", durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`FAILED`);
    console.error(`  Error: ${message}`);
    return { relPath: job.relPath, lang: job.lang, status: "error", durationMs, error: message };
  }
}

// ---------------------------------------------------------------------------
// Build job list
// ---------------------------------------------------------------------------

export function buildJobs(args: CliArgs): TranslationJob[] {
  const langs = args.lang === "all" ? Object.keys(LANGUAGES) : [args.lang];

  let relPaths: string[];
  if (args.file) {
    // Single-file mode: normalise path separator
    const normalised = args.file.replace(/\\/g, "/");
    const abs = path.join(WEBSITE_DIR, normalised);
    if (!fs.existsSync(abs)) {
      throw new Error(`Source file not found: ${abs}`);
    }
    relPaths = [normalised];
  } else {
    relPaths = findMarkdownFiles(WEBSITE_DIR);
  }

  const jobs: TranslationJob[] = [];
  for (const lang of langs) {
    if (args.lang !== "all" && !LANGUAGES[lang]) {
      throw new Error(
        `Unknown language code: ${lang}\nSupported: ${Object.keys(LANGUAGES).join(", ")}`
      );
    }
    for (const relPath of relPaths) {
      jobs.push({
        relPath,
        sourcePath: path.join(WEBSITE_DIR, relPath),
        targetPath: path.join(WEBSITE_DIR, lang, relPath),
        lang,
      });
    }
  }

  return jobs;
}
