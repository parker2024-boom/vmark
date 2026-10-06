/**
 * Table Escape Handlers
 *
 * Handles ArrowUp/ArrowDown at table boundaries:
 * - ArrowUp at first row of first-block table → insert paragraph before
 * - ArrowDown at last row of last-block table → insert paragraph after
 *
 * @module plugins/tableUI/tableEscape
 */

import type { EditorView } from "@tiptap/pm/view";
import { getTableInfo, setSelectionNear } from "./tableActions.tiptap";

/**
 * Check if table is the first block in the document.
 * @param tablePos - Position where the table starts
 */
export function isTableFirstBlock(tablePos: number): boolean {
  return tablePos === 0;
}

/**
 * Check if table is the last block in the document.
 * @param tablePos - Position where the table starts
 * @param tableNodeSize - Size of the table node
 * @param docSize - Total document size
 */
export function isTableLastBlock(tablePos: number, tableNodeSize: number, docSize: number): boolean {
  return tablePos + tableNodeSize === docSize;
}

/**
 * Handle ArrowUp when cursor is in the first row of a table.
 * If table is the first block, insert a paragraph before it.
 * @returns true if handled, false to let default behavior proceed
 */
export function escapeTableUp(view: EditorView): boolean {
  const info = getTableInfo(view);
  if (!info) return false;

  // Only handle when in first row
  if (info.rowIndex !== 0) return false;

  // Only handle when table is first block
  if (!isTableFirstBlock(info.tablePos)) return false;

  // Insert paragraph before table
  const { state, dispatch } = view;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;

  const tr = state.tr.insert(0, paragraphType.create());
  // Move cursor to the new paragraph (position 1, inside the paragraph)
  setSelectionNear(view, tr, 1);
  dispatch(tr);
  view.focus();
  return true;
}

/**
 * Handle ArrowDown when cursor is in the last row of a table.
 * If table is the last block, insert a paragraph after it.
 * @returns true if handled, false to let default behavior proceed
 */
export function escapeTableDown(view: EditorView): boolean {
  const info = getTableInfo(view);
  if (!info) return false;

  // Only handle when in last row
  if (info.rowIndex !== info.numRows - 1) return false;

  // Only handle when table is last block
  const docSize = view.state.doc.content.size;
  if (!isTableLastBlock(info.tablePos, info.tableNode.nodeSize, docSize)) return false;

  // Insert paragraph after table
  const { state, dispatch } = view;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;

  const insertPos = info.tablePos + info.tableNode.nodeSize;
  const tr = state.tr.insert(insertPos, paragraphType.create());
  // Move cursor to the new paragraph
  setSelectionNear(view, tr, insertPos + 1);
  dispatch(tr);
  view.focus();
  return true;
}
