/**
 * Linebreak Detection
 *
 * Purpose: Detect line ending style (LF vs CRLF) and hard break convention
 * (backslash vs two-spaces) in existing markdown documents. Used on file load
 * to preserve the author's formatting conventions on save.
 *
 * Key decisions:
 *   - The hard breaks counted are the ones a parse of the text finds
 *     (`findHardBreakRanges`). A line ending in a backslash or two spaces is
 *     also a LaTeX row in `$$` math, a padded table row, code, an HTML block,
 *     frontmatter, or a paragraph's literal last character; no line pattern
 *     tells those apart, and counting them misreports the author's style,
 *     which a save then rewrites every real break into.
 *   - The parse runs only when some line could be a break at all; a document
 *     with none is "unknown" for free. Too deeply nested to parse is
 *     "unknown" too: the style cannot be told.
 *   - Reports "mixed" when both backslash and two-space breaks are present
 *   - Lone \r is treated as CRLF (legacy Mac line endings)
 *
 * @coordinates-with utils/linebreaks.ts — applies the detected style on save
 * @coordinates-with utils/markdownPipeline/hardBreakRanges.ts — where the breaks are
 * @coordinates-with stores/documentStore.ts — stores detection result per document
 * @module utils/linebreakDetection
 */

import { findHardBreakRanges } from "./markdownPipeline/hardBreakRanges";

/** Detected line ending style of a document. */
export type LineEnding = "lf" | "crlf" | "unknown";
/** Detected hard break convention in a document. */
export type HardBreakStyle = "backslash" | "twoSpaces" | "mixed" | "unknown";
/** User preference for line ending normalization on save. */
export type LineEndingOnSave = "preserve" | "lf" | "crlf";
/** User preference for hard break style normalization on save. */
export type HardBreakStyleOnSave = "preserve" | "backslash" | "twoSpaces";

/** Combined result of line ending and hard break style detection. */
export interface LinebreakDetectionResult {
  lineEnding: LineEnding;
  hardBreakStyle: HardBreakStyle;
}

function detectLineEnding(text: string): LineEnding {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "crlf";
  if (text.includes("\n")) return "lf";
  return "unknown";
}

/** Some line ends in a backslash or in two spaces: a superset of hard breaks. */
const BREAK_CANDIDATE = /(?:\\| {2})$/m;

function detectHardBreakStyle(text: string): HardBreakStyle {
  // Editor text — what the parser's offsets address: LF only, no BOM.
  const editorText = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!BREAK_CANDIDATE.test(editorText)) return "unknown";
  const breaks = findHardBreakRanges(editorText);
  if (breaks === null) return "unknown";

  const backslash = breaks.some((found) => found.spelling === "backslash");
  const twoSpaces = breaks.some((found) => found.spelling === "twoSpaces");
  if (backslash && twoSpaces) return "mixed";
  if (backslash) return "backslash";
  if (twoSpaces) return "twoSpaces";
  return "unknown";
}

/** Detect the line ending style (LF/CRLF) and hard break convention of a markdown document. */
export function detectLinebreaks(text: string): LinebreakDetectionResult {
  return {
    lineEnding: detectLineEnding(text),
    hardBreakStyle: detectHardBreakStyle(text),
  };
}
