/**
 * The supported documentation languages and the shapes the CLI passes around.
 *
 * @coordinates-with scripts/translate-docs.ts — the CLI that drives this module
 * @module scripts/translate-docs/model
 */

// ---------------------------------------------------------------------------
// Supported languages
// ---------------------------------------------------------------------------

export const LANGUAGES: Record<string, string> = {
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  "pt-BR": "Brazilian Portuguese",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliArgs {
  lang: string; // language code or "all"
  file: string | null; // single file path relative to website/, or null
  dryRun: boolean;
  force: boolean;
}

export interface TranslationJob {
  relPath: string; // relative to website/, e.g. "guide/features.md"
  sourcePath: string; // absolute
  targetPath: string; // absolute
  lang: string;
}

export interface JobResult {
  relPath: string;
  lang: string;
  status: "translated" | "skipped" | "error" | "dry-run";
  durationMs?: number;
  error?: string;
}
