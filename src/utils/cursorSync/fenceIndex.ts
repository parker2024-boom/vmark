/**
 * Fence Index (Source Mode)
 *
 * Purpose: answer "which fenced code block, if any, contains this line?" for
 * the CodeMirror source editor without reading the document. The cursor-sync
 * snapshot asks it on every keystroke and every cursor move, and files of
 * 1 MB and more are forced into Source mode, so the answer may not cost a
 * pass over the text.
 *
 * Pipeline: a StateField holds the line numbers of the document's fence lines.
 * A transaction re-reads only the lines its changes touch. Each marker carries
 * the fence still open after it, so a lookup is a binary search.
 *
 * Key decisions:
 *   - A fence line is one whose first non-whitespace characters are three
 *     backticks or three tildes. A fence closes only on a marker of its own
 *     kind; a marker of the other kind inside it is content. This is the
 *     line-oriented rule the cursor anchors have always used, kept exactly so
 *     that anchors computed in Source mode still land where they did.
 *   - Markers are line numbers, not offsets: typing inside a line moves no
 *     marker at all, so the common keystroke returns the same index.
 *   - An edit that adds or removes lines between two fences displaces every
 *     marker below it. That displacement is recorded once (`shiftFrom`,
 *     `shiftBy`) instead of being written into each marker, so pressing Enter
 *     repeatedly in one place costs a lookup, not a pass over the markers.
 *     Moving to another place folds the pending displacement in first.
 *   - Only an edit that touches a fence line, or creates one, rebuilds the
 *     marker list — one pass over the markers, still not over the lines.
 *   - A state without the field still gets a correct answer, by reading the
 *     lines up to the one asked about. Only the editor that installs the field
 *     gets the cheap path.
 *
 * @coordinates-with cursorSync/codemirror.ts — the only reader
 * @coordinates-with components/Editor/SourceEditor.tsx — installs the field
 * @module utils/cursorSync/fenceIndex
 */

import { StateField, type EditorState, type Text, type Transaction } from "@codemirror/state";

type FenceKind = "`" | "~";

interface RawMarker {
  /** 1-based line number of the fence line, before any pending displacement. */
  readonly line: number;
  readonly kind: FenceKind;
}

interface FenceMarker extends RawMarker {
  /** Position in the marker list of the fence still open after this one, or -1. */
  readonly open: number;
}

/** The fence lines of a document, in document order. */
export interface FenceIndex {
  readonly markers: readonly FenceMarker[];
  /** Markers from this position on sit `shiftBy` lines below their recorded line. */
  readonly shiftFrom: number;
  readonly shiftBy: number;
}

/** Lines touched by one changed range, in the old and in the new document. */
interface TouchedLines {
  readonly oldFirst: number;
  readonly oldLast: number;
  readonly newFirst: number;
  readonly newLast: number;
}

const FENCE_LINE = /^\s*(`{3}|~{3})/;

function fenceKindOf(lineText: string): FenceKind | null {
  const match = FENCE_LINE.exec(lineText);
  return match ? (match[1][0] as FenceKind) : null;
}

/** Append the fence lines among lines `fromLine`..`toLine` (1-based, inclusive) to `out`. */
function scanLines(doc: Text, fromLine: number, toLine: number, out: RawMarker[]): void {
  if (fromLine > toLine) return;
  let line = fromLine;
  for (const text of doc.iterLines(fromLine, toLine + 1)) {
    const kind = fenceKindOf(text);
    if (kind) out.push({ line, kind });
    line += 1;
  }
}

/** Resolve, for every marker, which fence is open once it has been read. */
function link(markers: readonly RawMarker[]): FenceIndex {
  const linked: FenceMarker[] = [];
  let open = -1;
  markers.forEach(({ line, kind }, position) => {
    if (open < 0) open = position;
    else if (markers[open].kind === kind) open = -1;
    linked.push({ line, kind, open });
  });
  return { markers: linked, shiftFrom: linked.length, shiftBy: 0 };
}

/** The index of the first `throughLine` lines of `doc`. */
function buildFenceIndex(doc: Text, throughLine: number): FenceIndex {
  const markers: RawMarker[] = [];
  scanLines(doc, 1, throughLine, markers);
  return link(markers);
}

/** Where marker `position` is now, with the pending displacement applied. */
function lineOf(index: FenceIndex, position: number): number {
  const { line } = index.markers[position];
  return position >= index.shiftFrom ? line + index.shiftBy : line;
}

/** How many markers sit on a line before `line` — the position of the first one at or after it. */
function markersBefore(index: FenceIndex, line: number): number {
  let low = 0;
  let high = index.markers.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (lineOf(index, mid) < line) low = mid + 1;
    else high = mid;
  }
  return low;
}

function touchedLines(tr: Transaction): TouchedLines[] {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  const touched: TouchedLines[] = [];
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    touched.push({
      oldFirst: oldDoc.lineAt(fromA).number,
      oldLast: oldDoc.lineAt(toA).number,
      newFirst: newDoc.lineAt(fromB).number,
      newLast: newDoc.lineAt(toB).number,
    });
  });
  return touched;
}

/**
 * The position of the marker every change sits just above, when the changes
 * leave the marker list as it is: no fence line touched, none created, and
 * all of them between the same two fences. Otherwise null.
 */
function gapOfChanges(index: FenceIndex, touched: readonly TouchedLines[], newDoc: Text): number | null {
  let gap: number | null = null;
  const found: RawMarker[] = [];
  for (const { oldFirst, oldLast, newFirst, newLast } of touched) {
    const position = markersBefore(index, oldFirst);
    if (position < index.markers.length && lineOf(index, position) <= oldLast) return null;
    if (gap !== null && gap !== position) return null;
    gap = position;
    scanLines(newDoc, newFirst, newLast, found);
    if (found.length > 0) return null;
  }
  return gap;
}

/** Re-read the touched lines and carry every other marker across. */
function rebuild(index: FenceIndex, touched: readonly TouchedLines[], newDoc: Text): FenceIndex {
  const markers: RawMarker[] = [];
  let next = 0;
  let shift = 0;
  let scannedThrough = 0;
  const carry = (before: number) => {
    for (; next < index.markers.length && lineOf(index, next) < before; next += 1) {
      markers.push({ line: lineOf(index, next) + shift, kind: index.markers[next].kind });
    }
  };
  for (const { oldFirst, oldLast, newFirst, newLast } of touched) {
    // Untouched lines above this change keep their text and only move.
    carry(oldFirst);
    while (next < index.markers.length && lineOf(index, next) <= oldLast) next += 1;
    // Two changes on one line both name it; read it once.
    scanLines(newDoc, Math.max(newFirst, scannedThrough + 1), newLast, markers);
    scannedThrough = Math.max(scannedThrough, newLast);
    shift = newLast - oldLast;
  }
  carry(Number.POSITIVE_INFINITY);
  return link(markers);
}

/** `index` with every marker from `position` on moved down `lines` lines. */
function displace(index: FenceIndex, position: number, lines: number): FenceIndex {
  if (lines === 0 || position >= index.markers.length) return index;
  if (index.shiftBy === 0 || index.shiftFrom === position) {
    return { markers: index.markers, shiftFrom: position, shiftBy: index.shiftBy + lines };
  }
  // A displacement is pending somewhere else: write it into the markers first.
  const markers = index.markers.map((marker, at) => ({ ...marker, line: lineOf(index, at) }));
  return { markers, shiftFrom: position, shiftBy: lines };
}

/**
 * The fence index of the source editor's document, kept current by re-reading
 * only the lines each transaction touches.
 */
export const sourceFenceIndex = StateField.define<FenceIndex>({
  create: (state) => buildFenceIndex(state.doc, state.doc.lines),
  update(index, tr) {
    if (!tr.docChanged) return index;
    const touched = touchedLines(tr);
    const gap = gapOfChanges(index, touched, tr.newDoc);
    if (gap === null) return rebuild(index, touched, tr.newDoc);
    return displace(index, gap, tr.newDoc.lines - tr.startState.doc.lines);
  },
});

/**
 * The 1-based line number of the opening fence of the code block containing
 * line `lineNumber` (1-based), or null when that line is outside every block.
 * An opening fence line is inside its own block; a closing fence line is not.
 * A line number past the end is read as the last line.
 */
export function fenceStartLineAt(state: EditorState, lineNumber: number): number | null {
  if (lineNumber < 1) return null;
  const line = Math.min(lineNumber, state.doc.lines);
  const index = state.field(sourceFenceIndex, false) ?? buildFenceIndex(state.doc, line);
  const through = markersBefore(index, line + 1);
  if (through === 0) return null;
  const { open } = index.markers[through - 1];
  return open < 0 ? null : lineOf(index, open);
}
