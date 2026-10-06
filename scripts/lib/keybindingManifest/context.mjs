/**
 * The keybinding drift gate's shared context: the repository root, the paths
 * of the four sources it compares, and its fail-closed exits.
 *
 * Purpose: every leg of the gate reads files and aborts the same way — a
 * missing or unreadable source exits non-zero with one `❌` line rather than
 * letting a leg run over nothing. One definition keeps that rule identical
 * across the modules the gate is split into.
 *
 * @coordinates-with scripts/check-keybinding-manifest.mjs — the CLI that runs the legs
 * @module scripts/lib/keybindingManifest/context
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFS_PATH = "src/stores/settingsStore/shortcutDefinitions.ts";
export const RUST_PATH = "src-tauri/src/menu/localized.test.rs";
export const LOCALIZED_DIR = "src-tauri/src/menu/localized";
export const DOCS_PATH = "website/guide/shortcuts.md";

/** Print one failure and exit non-zero: the gate fails closed. */
export function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

/** Read a repo-relative file or die (fail-closed). */
export function readOrDie(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch (err) {
    fail(`cannot read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Unescape a JS/TS double-quoted string body into its runtime value. */
export function unquote(rawBody) {
  return JSON.parse(`"${rawBody}"`);
}
