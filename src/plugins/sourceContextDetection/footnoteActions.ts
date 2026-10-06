/**
 * Footnote Actions for Source Mode
 *
 * Parsing and manipulation of markdown footnotes.
 * Supports:
 * - Alphanumeric labels: [^1], [^note], [^ref-1], [^my_ref]
 * - Multi-line definitions with indentation
 * - Code block awareness (ignores content in fenced/indented code)
 * - Orphan cleanup
 * - Sequential renumbering with consolidation at document end (the steps
 *   live in footnoteRenumber.ts)
 *
 * @module plugins/sourceContextDetection/footnoteActions
 */

import {
  appendConsolidatedDefinitions,
  buildLabelMap,
  needsRenumber,
  relabelReferences,
  removeDefinitionsWithShift,
} from "./footnoteRenumber";
import type { FootnoteDef, FootnoteRef } from "./footnoteTypes";

// ===========================================
// Code Block Detection
// ===========================================

interface CodeBlockRange {
  start: number;
  end: number;
}

/**
 * Find all code block ranges (fenced and indented) in the document.
 */
function findCodeBlockRanges(doc: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const lines = doc.split("\n");
  let pos = 0;
  let inFencedBlock = false;
  let fenceStart = 0;
  let fenceChar = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = pos;
    const lineEnd = pos + line.length;

    // Check for fenced code block markers
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFencedBlock) {
        inFencedBlock = true;
        fenceStart = lineStart;
        fenceChar = fenceMatch[1][0];
      } else if (line.startsWith(fenceChar.repeat(3))) {
        inFencedBlock = false;
        ranges.push({ start: fenceStart, end: lineEnd });
      }
    }

    // Check for indented code block (4 spaces or tab, not in list context)
    // Only if not already in a fenced block and previous line is blank or start
    if (!inFencedBlock && (line.startsWith("    ") || line.startsWith("\t"))) {
      const prevLine = i > 0 ? lines[i - 1] : "";
      if (prevLine.trim() === "" || i === 0) {
        // Find extent of indented block
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          if (nextLine.startsWith("    ") || nextLine.startsWith("\t") || nextLine.trim() === "") {
            j++;
          } else {
            break;
          }
        }
        // Calculate block end position
        let blockEnd = lineStart;
        for (let k = i; k < j; k++) {
          blockEnd += lines[k].length + 1;
        }
        ranges.push({ start: lineStart, end: blockEnd - 1 });
      }
    }

    pos = lineEnd + 1; // +1 for newline
  }

  // Handle unclosed fenced block
  if (inFencedBlock) {
    ranges.push({ start: fenceStart, end: doc.length });
  }

  return ranges;
}

/**
 * Check if a position is inside any code block.
 */
function isInCodeBlock(pos: number, ranges: CodeBlockRange[]): boolean {
  for (const range of ranges) {
    if (pos >= range.start && pos < range.end) {
      return true;
    }
  }
  return false;
}

// ===========================================
// Parsing Functions
// ===========================================

/**
 * Parse all footnote references in the document.
 * Supports alphanumeric labels: [^1], [^note], [^ref-1]
 * Ignores references inside code blocks.
 *
 * @param doc - The document text to parse
 * @param codeRanges - Optional pre-computed code block ranges (for performance)
 */
export function parseReferences(doc: string, codeRanges?: CodeBlockRange[]): FootnoteRef[] {
  const refs: FootnoteRef[] = [];
  const ranges = codeRanges ?? findCodeBlockRanges(doc);

  // Match [^label] where label is alphanumeric with hyphens/underscores
  // Negative lookahead to exclude definitions [^label]:
  const pattern = /\[\^([a-zA-Z0-9_-]+)\](?!:)/g;
  let match;

  while ((match = pattern.exec(doc)) !== null) {
    if (!isInCodeBlock(match.index, ranges)) {
      refs.push({
        label: match[1],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return refs;
}

/**
 * Parse all footnote definitions in the document.
 * Handles multi-line definitions with indentation.
 * Ignores definitions inside code blocks.
 *
 * @param doc - The document text to parse
 * @param codeRanges - Optional pre-computed code block ranges (for performance)
 */
export function parseDefinitions(doc: string, codeRanges?: CodeBlockRange[]): FootnoteDef[] {
  const defs: FootnoteDef[] = [];
  const ranges = codeRanges ?? findCodeBlockRanges(doc);
  const lines = doc.split("\n");

  let pos = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const lineStart = pos;

    // Check for definition start: [^label]:
    const defMatch = line.match(/^\[\^([a-zA-Z0-9_-]+)\]:\s?(.*)/);

    if (defMatch && !isInCodeBlock(lineStart, ranges)) {
      const label = defMatch[1];
      let content = defMatch[2];
      let defEnd = lineStart + line.length;

      // Look for continuation lines (indented or blank)
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        const nextLineStart = defEnd + 1;

        // Check if next line is a new definition
        if (nextLine.match(/^\[\^[a-zA-Z0-9_-]+\]:/)) {
          break;
        }

        // Check if continuation (indented with 4 spaces or tab, or blank)
        if (nextLine.startsWith("    ") || nextLine.startsWith("\t") || nextLine.trim() === "") {
          content += "\n" + nextLine;
          defEnd = nextLineStart + nextLine.length;
          j++;
        } else {
          // Non-indented, non-blank line ends the definition
          break;
        }
      }

      // Trim trailing blank lines from content
      content = content.replace(/\n+$/, "");

      defs.push({
        label,
        start: lineStart,
        end: defEnd,
        content,
      });

      // Skip to after the definition
      i = j;
      pos = defEnd + 1;
      continue;
    }

    pos = lineStart + line.length + 1;
    i++;
  }

  return defs;
}

// ===========================================
// Renumbering and Cleanup
// ===========================================

/**
 * Renumber footnotes sequentially and consolidate definitions at document end.
 *
 * - Labels are assigned based on first reference appearance order
 * - All definitions are moved to the end of the document
 * - Orphaned definitions (no reference) are removed
 * - Missing definitions (reference without definition) get empty placeholders
 *
 * Returns null if no changes needed.
 */
export function renumberFootnotes(doc: string): string | null {
  // Compute code ranges once and share between parsing functions
  const codeRanges = findCodeBlockRanges(doc);

  const refs = parseReferences(doc, codeRanges);
  if (refs.length === 0) return null;

  const defs = parseDefinitions(doc, codeRanges);
  const labelMap = buildLabelMap(refs);
  if (!needsRenumber(doc, defs, labelMap)) return null;

  const { text, adjustPosition } = removeDefinitionsWithShift(doc, defs);
  const body = relabelReferences(text, refs, labelMap, adjustPosition);
  return appendConsolidatedDefinitions(body, labelMap, defs);
}

/**
 * Remove orphaned definitions (definitions without corresponding references).
 * Returns null if no orphans found.
 */
export function cleanupOrphanedDefinitions(doc: string): string | null {
  if (!doc) return null;

  const refs = parseReferences(doc);
  const defs = parseDefinitions(doc);

  if (defs.length === 0) return null;

  const refLabels = new Set(refs.map((r) => r.label));
  const orphanDefs = defs.filter((d) => !refLabels.has(d.label));

  if (orphanDefs.length === 0) return null;

  // Remove orphaned definitions in reverse order
  let result = doc;
  const sortedOrphans = [...orphanDefs].sort((a, b) => b.start - a.start);

  for (const def of sortedOrphans) {
    // Also remove trailing newlines
    let endPos = def.end;
    while (endPos < result.length && result[endPos] === "\n") {
      endPos++;
    }
    result = result.slice(0, def.start) + result.slice(endPos);
  }

  // Trim trailing whitespace
  result = result.trimEnd();

  return result;
}
