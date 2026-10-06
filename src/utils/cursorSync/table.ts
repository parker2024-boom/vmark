/**
 * Table Cursor Anchoring (Source Mode)
 *
 * Purpose: Map cursor position in a markdown table row to (row, col, offsetInCell)
 * coordinates and back. This enables precise cursor restoration across mode switches
 * for tables, where character offsets are unreliable due to pipe separators and padding.
 *
 * Key decisions:
 *   - Cell ranges account for escaped pipes (\\|) inside cells
 *   - Leading/trailing pipe handling follows GFM conventions
 *   - Row index is relative to the table header (row 0 = header row)
 *   - Header detection scans upward through all preceding rows (supports tables of any size)
 *   - Lines are read one at a time through a LineSource, so the editor can ask
 *     about the cursor's table without splitting the whole document into lines
 *
 * @coordinates-with cursorSync/tiptapAnchors.ts — the WYSIWYG counterpart
 * @module utils/cursorSync/table
 */

import type { BlockAnchor } from "@/types/cursorSync";

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableRowLine(line: string): boolean {
  return /\|/.test(line);
}

/**
 * The lines of a document, read one at a time by 0-based index. An array of
 * lines is one; so is a view over an editor document, which lets a caller ask
 * about one table without materializing every line of the file.
 */
export interface LineSource {
  readonly length: number;
  at(index: number): string | undefined;
}

function findTableHeaderLineIndex(lines: LineSource, lineIndex: number): number | null {
  const lineAt = (index: number) => lines.at(index) ?? "";
  // Current line is separator
  if (isTableSeparatorLine(lineAt(lineIndex)) && lineIndex - 1 >= 0) {
    if (isTableRowLine(lineAt(lineIndex - 1))) return lineIndex - 1;
  }

  // Current line is header (next line is separator)
  if (lineIndex + 1 < lines.length &&
      isTableRowLine(lineAt(lineIndex)) && isTableSeparatorLine(lineAt(lineIndex + 1))) {
    return lineIndex;
  }

  // Scan upward for separator line, then header above it
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (isTableSeparatorLine(lineAt(i)) && i - 1 >= 0 && isTableRowLine(lineAt(i - 1))) {
      return i - 1;
    }
    if (!isTableRowLine(lineAt(i))) break;
  }

  return null;
}

interface TableCellRange {
  rawStart: number;
  rawEnd: number;
  contentStart: number;
  contentEnd: number;
}

function getTableCellRanges(lineText: string): TableCellRange[] {
  const separators: number[] = [];
  for (let i = 0; i < lineText.length; i += 1) {
    const ch = lineText[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "|") {
      separators.push(i);
    }
  }

  if (separators.length === 0) return [];

  const lineEnd = lineText.length;
  const trimmedRight = lineText.replace(/\s+$/, "");
  const hasLeadingPipe = lineText.slice(0, separators[0]).trim().length === 0;
  const hasTrailingPipe =
    separators[separators.length - 1] === Math.max(0, trimmedRight.length - 1);

  const ranges: TableCellRange[] = [];
  let cellStart = hasLeadingPipe ? separators[0] + 1 : 0;
  const startIndex = hasLeadingPipe ? 1 : 0;

  for (let i = startIndex; i < separators.length; i += 1) {
    const sepIndex = separators[i];
    const rawStart = cellStart;
    const rawEnd = sepIndex;
    const contentStart = skipWhitespaceForward(lineText, rawStart, rawEnd);
    const contentEnd = skipWhitespaceBackward(lineText, rawEnd, rawStart);
    ranges.push({ rawStart, rawEnd, contentStart, contentEnd });
    cellStart = sepIndex + 1;
  }

  if (!hasTrailingPipe && cellStart <= lineEnd) {
    const rawStart = cellStart;
    const rawEnd = lineEnd;
    const contentStart = skipWhitespaceForward(lineText, rawStart, rawEnd);
    const contentEnd = skipWhitespaceBackward(lineText, rawEnd, rawStart);
    ranges.push({ rawStart, rawEnd, contentStart, contentEnd });
  }

  return ranges;
}

function skipWhitespaceForward(text: string, start: number, end: number): number {
  let idx = start;
  while (idx < end && text[idx] === " ") idx += 1;
  return idx;
}

function skipWhitespaceBackward(text: string, end: number, start: number): number {
  let idx = end;
  while (idx > start && text[idx - 1] === " ") idx -= 1;
  return idx;
}

/**
 * Table anchor (row, column, offset in cell) for a cursor at `columnInLine` of
 * line `lineIndex` (0-based), or undefined when that line is not a table row.
 * Reads the cursor's line and the rows above it up to the table's header —
 * never lines outside the table.
 */
export function getTableAnchorForLine(
  lines: LineSource,
  lineIndex: number,
  columnInLine: number
): BlockAnchor | undefined {
  const lineText = lines.at(lineIndex);
  if (lineText === undefined) return undefined;
  const headerLine = findTableHeaderLineIndex(lines, lineIndex);
  if (headerLine === null) return undefined;
  if (isTableSeparatorLine(lineText)) return undefined;

  const row =
    lineIndex === headerLine ? 0 : Math.max(0, lineIndex - (headerLine + 1));

  const cellRanges = getTableCellRanges(lineText);
  if (cellRanges.length === 0) return undefined;

  let col = cellRanges.findIndex(
    (range) => columnInLine >= range.rawStart && columnInLine <= range.rawEnd
  );
  if (col === -1) {
    col = columnInLine < cellRanges[0].rawStart ? 0 : cellRanges.length - 1;
  }

  const cell = cellRanges[col];
  const maxOffset = Math.max(0, cell.contentEnd - cell.contentStart);
  const offsetInCell = clamp(columnInLine - cell.contentStart, 0, maxOffset);

  return {
    kind: "table",
    row,
    col,
    offsetInCell,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Restore cursor position in a markdown table line using block anchor.
 * Returns the column position, or null if restoration failed.
 */
export function restoreTableColumnFromAnchor(
  lineText: string,
  anchor: { col: number; offsetInCell: number }
): number | null {
  const cellRanges = getTableCellRanges(lineText);
  if (cellRanges.length === 0) return null;

  // Clamp column to valid range
  const col = clamp(anchor.col, 0, cellRanges.length - 1);
  const cell = cellRanges[col];

  // Calculate position: content start + offset (clamped)
  const maxOffset = Math.max(0, cell.contentEnd - cell.contentStart);
  const offset = clamp(anchor.offsetInCell, 0, maxOffset);

  return cell.contentStart + offset;
}
