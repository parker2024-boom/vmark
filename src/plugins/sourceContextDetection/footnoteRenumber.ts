/**
 * Footnote Renumbering Steps
 *
 * Purpose: The pure steps `renumberFootnotes` (footnoteActions.ts) composes —
 * number labels by first reference, decide whether anything must change,
 * remove definitions while tracking the position shift, relabel references,
 * and append the consolidated definition list.
 *
 * Key decisions:
 *   - Removed ranges are computed once, in original-document coordinates, and
 *     drive both the text removal and the reference position shift. Two
 *     computations that disagree by one character relabel references at the
 *     wrong offset and corrupt the text.
 *   - Definitions separated only by newlines are removed as one range; one
 *     newline is kept when text follows the range.
 *
 * @coordinates-with footnoteActions.ts — parsing, and the `renumberFootnotes` entry point
 * @coordinates-with footnoteTypes.ts — the reference and definition shapes
 * @module plugins/sourceContextDetection/footnoteRenumber
 */

import type { FootnoteDef, FootnoteRef } from "./footnoteTypes";

/** Old label → new sequential number, in order of first reference. */
export function buildLabelMap(refs: FootnoteRef[]): Map<string, string> {
  const labelMap = new Map<string, string>();
  for (const ref of refs) {
    if (!labelMap.has(ref.label)) {
      labelMap.set(ref.label, String(labelMap.size + 1));
    }
  }
  return labelMap;
}

/**
 * True when renumbering would change the document: a label is not its
 * sequential number, a definition has no reference, a reference has no
 * definition, or non-whitespace text follows the last definition.
 */
export function needsRenumber(
  doc: string,
  defs: FootnoteDef[],
  labelMap: Map<string, string>,
): boolean {
  for (const [oldLabel, newLabel] of labelMap) {
    if (oldLabel !== newLabel) return true;
  }
  if (defs.some((def) => !labelMap.has(def.label))) return true;

  const defLabels = new Set(defs.map((def) => def.label));
  for (const refLabel of labelMap.keys()) {
    if (!defLabels.has(refLabel)) return true;
  }

  if (defs.length === 0) return false;
  const lastDefEnd = Math.max(...defs.map((def) => def.end));
  return doc.slice(lastDefEnd).trim().length > 0;
}

interface Removal {
  start: number;
  length: number;
}

function computeRemovals(doc: string, defs: FootnoteDef[]): Removal[] {
  const skipNewlines = (from: number): number => {
    let pos = from;
    while (pos < doc.length && doc[pos] === "\n") pos++;
    return pos;
  };

  const sorted = [...defs].sort((a, b) => a.start - b.start);
  const removals: Removal[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].start;
    let endPos = skipNewlines(sorted[i].end);
    while (i + 1 < sorted.length && sorted[i + 1].start === endPos) {
      i++;
      endPos = skipNewlines(sorted[i].end);
    }
    // @edge-case keep one newline when text follows the removed range
    if (endPos > sorted[i].end && endPos < doc.length) endPos--;
    removals.push({ start, length: endPos - start });
  }
  return removals;
}

/**
 * Remove every definition (and its trailing newlines) from `doc`.
 * `adjustPosition` maps an original-document offset to the returned text, or
 * to -1 when the offset lies inside a removed range.
 */
export function removeDefinitionsWithShift(
  doc: string,
  defs: FootnoteDef[],
): { text: string; adjustPosition: (pos: number) => number } {
  const removals = computeRemovals(doc, defs);

  let text = "";
  let cursor = 0;
  for (const removal of removals) {
    text += doc.slice(cursor, removal.start);
    cursor = removal.start + removal.length;
  }
  text += doc.slice(cursor);

  const adjustPosition = (pos: number): number => {
    let adjustment = 0;
    for (const removal of removals) {
      if (pos <= removal.start) continue;
      if (pos < removal.start + removal.length) return -1;
      adjustment += removal.length;
    }
    return pos - adjustment;
  };

  return { text, adjustPosition };
}

/**
 * Rewrite each reference to its new label in `text` (the document after
 * definition removal). References inside removed ranges are skipped.
 */
export function relabelReferences(
  text: string,
  refs: FootnoteRef[],
  labelMap: Map<string, string>,
  adjustPosition: (pos: number) => number,
): string {
  const placed = refs
    .map((ref) => ({ label: ref.label, at: adjustPosition(ref.start) }))
    .filter((ref) => ref.at >= 0)
    .sort((a, b) => b.at - a.at);

  let result = text;
  for (const ref of placed) {
    const newLabel = labelMap.get(ref.label);
    if (newLabel && newLabel !== ref.label) {
      const oldLength = `[^${ref.label}]`.length;
      result = result.slice(0, ref.at) + `[^${newLabel}]` + result.slice(ref.at + oldLength);
    }
  }
  return result;
}

/**
 * Trim the body and append one definition per label, in label-map order.
 * A label with no definition gets an empty placeholder; a label defined twice
 * keeps its last definition.
 */
export function appendConsolidatedDefinitions(
  body: string,
  labelMap: Map<string, string>,
  defs: FootnoteDef[],
): string {
  const contentByLabel = new Map(defs.map((def) => [def.label, def.content]));
  const definitionLines = [...labelMap].map(
    ([oldLabel, newLabel]) => `[^${newLabel}]: ${contentByLabel.get(oldLabel) ?? ""}`,
  );
  return body.trimEnd() + "\n\n" + definitionLines.join("\n");
}
