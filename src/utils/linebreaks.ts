/**
 * Linebreak Normalization
 *
 * Purpose: Normalize line endings and hard break styles before saving, and
 * expose a soft-equality comparison that tolerates cloud-sync rewrites.
 * Resolves user preference vs detected document convention, then transforms
 * the markdown content accordingly.
 *
 * Key decisions:
 *   - "preserve" preference defers to the document's detected style
 *   - New/unknown documents default to LF and two-spaces (widest compatibility)
 *   - Hard-break conversion rewrites only what the PARSER reads as a hard
 *     break. A line ending in a backslash or in two spaces is also a LaTeX row
 *     separator, a table row, a line of HTML or code, or a literal backslash,
 *     and rewriting those is silent data loss on save — so no line pattern
 *     decides. The algorithm, its verification and its size limit live in
 *     markdownPipeline/hardBreakRespell.ts; this file owns the line-ending
 *     contract around it (input in any convention, LF out).
 *   - softContentEquals folds benign differences that cloud-sync daemons
 *     (OneDrive/iCloud/Dropbox) introduce without changing semantic content
 *
 * @coordinates-with utils/linebreakDetection.ts — provides the detection inputs
 * @coordinates-with utils/markdownPipeline/hardBreakRespell.ts — respells hard
 *   breaks, from the parser's reading of where they are
 * @coordinates-with hooks/useExternalFileChanges.ts — uses softContentEquals to
 *   suppress spurious external-change prompts from sync-daemon rewrites
 * @module utils/linebreaks
 */

import type {
  HardBreakStyle,
  HardBreakStyleOnSave,
  LineEnding,
  LineEndingOnSave,
} from "@/utils/linebreakDetection";
import { respellHardBreaks } from "@/utils/markdownPipeline/hardBreakRespell";

export { HARD_BREAK_NORMALIZE_LIMIT } from "@/utils/markdownPipeline/hardBreakRespell";

/** Resolve user preference and detected doc style into a concrete hard break style. */
export function resolveHardBreakStyle(
  docStyle: HardBreakStyle,
  preference: HardBreakStyleOnSave
): "backslash" | "twoSpaces" {
  // Explicit user preference takes priority
  if (preference === "backslash") return "backslash";
  if (preference === "twoSpaces") return "twoSpaces";
  // Preserve detected document style
  if (docStyle === "backslash") return "backslash";
  if (docStyle === "twoSpaces") return "twoSpaces";
  // Default to twoSpaces for new/unknown docs (wider compatibility)
  return "twoSpaces";
}

/** Resolve user preference and detected doc line ending into LF or CRLF. */
export function resolveLineEndingOnSave(
  docLineEnding: LineEnding,
  preference: LineEndingOnSave
): "lf" | "crlf" {
  if (preference === "lf") return "lf";
  if (preference === "crlf") return "crlf";
  return docLineEnding === "crlf" ? "crlf" : "lf";
}

/**
 * Convert hard breaks to `target` spelling, touching only what the parser
 * reads as a hard break. Accepts any line-ending convention; returns LF text.
 *
 * Left exactly as written: anything that is not a hard break (math, tables,
 * HTML, code, frontmatter, a literal backslash, a paragraph's last line), a
 * break that cannot take the target spelling without changing meaning, and
 * text that is too large or too deeply nested to parse on a save.
 */
export function normalizeHardBreaks(text: string, target: "backslash" | "twoSpaces"): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return respellHardBreaks(normalized, target);
}

/** Normalize all line endings in text to the target style (LF or CRLF). */
export function normalizeLineEndings(text: string, target: "lf" | "crlf"): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (target === "crlf") {
    return normalized.replace(/\n/g, "\r\n");
  }
  return normalized;
}

/**
 * Strip a leading UTF-8 BOM (U+FEFF), if present.
 * Cloud sync engines (OneDrive, iCloud, Dropbox) sometimes add or remove BOM
 * during background normalization without changing the semantic content.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Compare two strings for "soft" content equality, ignoring differences that
 * cloud sync engines (OneDrive, iCloud, Dropbox, Syncthing) routinely introduce
 * during background rewrites:
 *
 *  - line endings (CRLF ↔ LF ↔ CR)
 *  - leading BOM (U+FEFF)
 *  - a single trailing newline (added or stripped)
 *
 * Returns `true` when both strings carry the same semantic content. Use this
 * in watcher paths to suppress spurious "file changed externally" prompts
 * caused by sync-daemon rewrites that don't alter what the user sees.
 *
 * Anything beyond these benign transforms (e.g. trailing-space trimming,
 * Unicode normalization) is *not* folded — those are real edits the user
 * deserves to know about.
 */
export function softContentEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const normA = stripBom(a).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  const normB = stripBom(b).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  return normA === normB;
}
