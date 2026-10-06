/**
 * Code block bounds — find the content range of the code block containing a
 * position, and keep only the multi-cursor ranges that lie inside it.
 *
 * @module plugins/multiCursor/codeBlockBounds
 */

import type { EditorState } from "@tiptap/pm/state";
import { SelectionRange } from "@tiptap/pm/state";

/** Position range of a code block's content. */
export interface CodeBlockBounds {
  from: number;
  to: number;
}

/** Returns the content bounds of the code block containing the given position, or null. */
export function getCodeBlockBounds(state: EditorState, pos: number): CodeBlockBounds | null {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "codeBlock" || node.type.name === "code_block") {
      return { from: $pos.start(depth), to: $pos.end(depth) };
    }
  }
  return null;
}

/** Filters selection ranges to only include those fully within the given bounds. */
export function filterRangesToBounds(
  ranges: readonly SelectionRange[],
  bounds: CodeBlockBounds
): SelectionRange[] {
  return ranges.filter((range) => range.$from.pos >= bounds.from && range.$to.pos <= bounds.to);
}
