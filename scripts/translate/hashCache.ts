/**
 * The diff-aware cache: a SHA-256 of the source stored beside each translated
 * file, so an unchanged source is skipped on the next run.
 *
 * @coordinates-with scripts/translate.ts — the CLI that drives this module
 * @module scripts/translate/hashCache
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Hash-based diff detection
// ---------------------------------------------------------------------------

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function getHashFilePath(targetFile: string): string {
  const dir = path.dirname(targetFile);
  const base = path.basename(targetFile);
  return path.join(dir, `.translate-hash-${base}.sha256`);
}

function readStoredHash(targetFile: string): string | null {
  const hashFile = getHashFilePath(targetFile);
  try {
    return fs.readFileSync(hashFile, "utf-8").trim();
  } catch {
    return null;
  }
}

export function writeStoredHash(targetFile: string, hash: string): void {
  const hashFile = getHashFilePath(targetFile);
  fs.writeFileSync(hashFile, hash + "\n", "utf-8");
}

export function isUpToDate(sourceHash: string, targetFile: string): boolean {
  if (!fs.existsSync(targetFile)) return false;
  const stored = readStoredHash(targetFile);
  return stored === sourceHash;
}
