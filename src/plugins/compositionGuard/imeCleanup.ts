/**
 * IME Cleanup
 *
 * Purpose: after a composition ends, repair what the browser left in the
 * document — a heading split in two, or the preedit text (the typed pinyin)
 * still standing in front of the committed characters.
 *
 * Key decisions:
 *   - The range examined starts at the composition's anchor and ends at the
 *     end of its block, so only text typed since the composition began can be
 *     removed. The caller supplies the anchor as a position in the CURRENT
 *     document; a stale one makes this delete text the user wrote.
 *   - Table cells can hold several paragraphs, so inside a cell the range
 *     runs to the cell boundary and may span newlines.
 *
 * @coordinates-with plugins/compositionGuard/tiptap.ts — calls this from the post-composition frame
 * @coordinates-with plugins/compositionGuard/compositionAnchor.ts — keeps the anchor current
 * @coordinates-with plugins/compositionGuard/splitBlockFix.ts — split-block repair for headings
 * @coordinates-with utils/imeGuard.ts — getImeCleanupPrefixLength, the leftover-preedit test
 * @module plugins/compositionGuard/imeCleanup
 */

import type { EditorView } from "@tiptap/pm/view";
import { getImeCleanupPrefixLength } from "@/utils/imeGuard";
import { fixCompositionSplitBlock } from "./splitBlockFix";

/** Depth of the table cell (or header cell) containing `pos`, or null. */
export function findTableCellDepth(view: EditorView, pos: number): number | null {
  const { doc } = view.state;
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      return depth;
    }
  }
  return null;
}

/**
 * Repair the document after the composition that began at `startPos`.
 *
 * @param view      The editor view; its current state is what gets repaired
 * @param startPos  The composition's anchor in the current document, or null
 *                  when it is no longer known — nothing is done then
 * @param composed  The committed text (e.g., "你好")
 * @param pinyin    The preedit text typed during composition (e.g., "nihao")
 */
export function cleanUpAfterComposition(
  view: EditorView,
  startPos: number | null,
  composed: string,
  pinyin: string,
): void {
  if (!composed || startPos === null) return;

  const { state } = view;
  let $start;
  try {
    $start = state.doc.resolve(startPos);
  } catch {
    return;
  }

  // Try split-block fix (paragraph now has composed text)
  const splitFix = fixCompositionSplitBlock(state, startPos, composed, pinyin);
  if (splitFix) {
    view.dispatch(splitFix);
    return;
  }

  let cleanupEnd = $start.end();
  let allowNewlines = false;

  // Table cells can contain multiple paragraphs, so use the
  // cell boundary and allow newlines in the cleanup range.
  // For every other block (paragraph, heading, code block,
  // list item, blockquote, etc.) $start.end() is correct.
  const tableDepth = findTableCellDepth(view, startPos);
  if (tableDepth !== null) {
    cleanupEnd = $start.end(tableDepth);
    allowNewlines = true;
  }

  if (startPos > cleanupEnd) return;

  const textBetween = state.doc.textBetween(startPos, cleanupEnd, "\n");
  const prefixLen = getImeCleanupPrefixLength(textBetween, composed, { allowNewlines });
  if (!prefixLen) return;

  view.dispatch(
    state.tr.delete(startPos, startPos + prefixLen).setMeta("uiEvent", "composition-cleanup"),
  );
}
