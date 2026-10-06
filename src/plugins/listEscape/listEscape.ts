/**
 * List Escape Handlers
 *
 * Handles ArrowUp/ArrowDown at list boundaries:
 * - ArrowUp at first item of first-block list → insert paragraph before
 * - ArrowDown at last item of last-block list → insert paragraph after
 *
 * @module plugins/listEscape/listEscape
 */

import type { EditorView } from "@tiptap/pm/view";
import { Selection } from "@tiptap/pm/state";

interface ListInfo {
  listPos: number;
  listNode: ReturnType<typeof import("@tiptap/pm/state").EditorState.prototype.doc.nodeAt>;
  itemIndex: number;
  itemCount: number;
  itemPos: number;
  isFirstItem: boolean;
  isLastItem: boolean;
}

/**
 * Get information about the list containing the cursor.
 */
function getListInfo(view: EditorView): ListInfo | null {
  const { state } = view;
  const { $from } = state.selection;

  // Find the list node (bulletList or orderedList)
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      const listPos = $from.before(depth);

      // Find which list item we're in
      let itemIndex = -1;
      let itemPos = -1;
      for (let d = $from.depth; d > depth; d--) {
        const parentNode = $from.node(d);
        if (parentNode.type.name === "listItem") {
          itemIndex = $from.index(d - 1);
          itemPos = $from.before(d);
          break;
        }
      }

      /* v8 ignore next -- @preserve Defensive guard: itemIndex stays -1 only if no listItem ancestor exists between cursor and list, which cannot occur in a well-formed document */
      if (itemIndex === -1) return null;

      const itemCount = node.childCount;

      return {
        listPos,
        listNode: node,
        itemIndex,
        itemCount,
        itemPos,
        isFirstItem: itemIndex === 0,
        isLastItem: itemIndex === itemCount - 1,
      };
    }
  }

  return null;
}

/**
 * Check if cursor is at the start of the first line in a list item.
 */
function isAtStartOfListItem(view: EditorView, info: ListInfo): boolean {
  const { state } = view;
  const { $from } = state.selection;

  // Get the first text position in this list item
  const itemNode = state.doc.nodeAt(info.itemPos);
  /* v8 ignore next -- @preserve Defensive guard: itemPos is derived from $from.before(d) which always points to a valid node */
  if (!itemNode) return false;

  // Check if cursor is at the very beginning of the first paragraph in the item
  // Account for: listItem(1) > paragraph(1) > text
  const firstContentPos = info.itemPos + 2; // +1 for listItem, +1 for first child (paragraph)

  return $from.pos <= firstContentPos;
}

/**
 * Check if cursor is at the end of the last line in a list item.
 */
function isAtEndOfListItem(view: EditorView, info: ListInfo): boolean {
  const { state } = view;
  const { $from } = state.selection;

  const itemNode = state.doc.nodeAt(info.itemPos);
  /* v8 ignore next -- @preserve Defensive guard: itemPos is derived from $from.before(d) which always points to a valid node */
  if (!itemNode) return false;

  // Check if cursor is at the end of the item
  const itemEnd = info.itemPos + itemNode.nodeSize - 1;

  return $from.pos >= itemEnd - 1;
}

/**
 * Check if list is the first block in the document.
 */
function isListFirstBlock(listPos: number): boolean {
  return listPos === 0;
}

/**
 * Check if list is the last block in the document.
 */
function isListLastBlock(listPos: number, listNodeSize: number, docSize: number): boolean {
  return listPos + listNodeSize === docSize;
}

/**
 * Handle ArrowUp when cursor is in the first item of a list.
 * If list is the first block, insert a paragraph before it.
 * @returns true if handled, false to let default behavior proceed
 */
export function escapeListUp(view: EditorView): boolean {
  const info = getListInfo(view);
  if (!info) return false;

  // Only handle when in first item
  if (!info.isFirstItem) return false;

  // Only handle when at start of the item
  if (!isAtStartOfListItem(view, info)) return false;

  // Only handle when list is first block
  if (!isListFirstBlock(info.listPos)) return false;

  // Insert paragraph before list
  const { state, dispatch } = view;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;

  const tr = state.tr.insert(0, paragraphType.create());
  // Move cursor to the new paragraph (position 1, inside the paragraph)
  tr.setSelection(Selection.near(tr.doc.resolve(1)));
  dispatch(tr);
  view.focus();
  return true;
}

/**
 * Handle ArrowDown when cursor is in the last item of a list.
 * If list is the last block, insert a paragraph after it.
 * @returns true if handled, false to let default behavior proceed
 */
export function escapeListDown(view: EditorView): boolean {
  const info = getListInfo(view);
  if (!info) return false;

  // Only handle when in last item
  if (!info.isLastItem) return false;

  // Only handle when at end of the item
  if (!isAtEndOfListItem(view, info)) return false;

  // Only handle when list is last block
  const docSize = view.state.doc.content.size;
  /* v8 ignore next -- @preserve Defensive guard: listNode is always set when getListInfo returns non-null (see line 53) */
  if (!info.listNode) return false;
  if (!isListLastBlock(info.listPos, info.listNode.nodeSize, docSize)) return false;

  // Insert paragraph after list
  const { state, dispatch } = view;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;

  const insertPos = info.listPos + info.listNode.nodeSize;
  const tr = state.tr.insert(insertPos, paragraphType.create());
  // Move cursor to the new paragraph
  tr.setSelection(Selection.near(tr.doc.resolve(insertPos + 1)));
  dispatch(tr);
  view.focus();
  return true;
}
