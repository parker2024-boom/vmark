/**
 * Block Bounds Detection for Smart Select-All
 *
 * Walks ProseMirror's depth tree to find the next meaningful container
 * that is strictly larger than the current selection.
 *
 * @module plugins/smartSelectAll/blockBounds
 */

import type { EditorState } from "@tiptap/pm/state";

export interface BlockBounds {
  from: number;
  to: number;
}

/**
 * Node types that constitute meaningful selection containers.
 * Skips paragraphs, headings, and doc — those are "invisible" expansions
 * where the selected text doesn't visually change.
 */
const CONTAINER_TYPES = new Set([
  "codeBlock",
  "code_block",
  "tableCell",
  "tableHeader",
  "tableRow",
  "table",
  "listItem",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
]);

/**
 * Find the next container up the depth tree that is strictly larger
 * than the current selection range [currentFrom, currentTo].
 *
 * Returns the bounds of the next-larger container, or null if none found.
 * When null, the caller should select the entire document.
 */
export function getNextContainerBounds(
  state: EditorState,
  currentFrom: number,
  currentTo: number,
): BlockBounds | null {
  const $from = state.doc.resolve(currentFrom);

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!CONTAINER_TYPES.has(node.type.name)) continue;

    const containerFrom = $from.start(depth);
    const containerTo = $from.end(depth);

    // Only return if strictly larger than current selection
    if (containerFrom < currentFrom || containerTo > currentTo) {
      return { from: containerFrom, to: containerTo };
    }
  }

  return null;
}
