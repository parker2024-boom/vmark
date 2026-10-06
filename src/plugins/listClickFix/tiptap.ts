/**
 * List Click Fix Extension
 *
 * Fixes cursor placement when clicking empty list items.
 *
 * Problem: When clicking an empty <li>, ProseMirror correctly computes
 * the position inside the list item and passes it to handleClick. But
 * after all handlers return false, PM's default behavior reads the
 * browser's native selection — which the browser resolved to the nearest
 * text node (often in a paragraph below the list). This overrides the
 * correct pos, and the cursor lands outside the list.
 *
 * Two scenarios are handled:
 *   1. pos is inside an empty listItem: force-set selection and return true
 *      to prevent PM from reading the wrong native selection.
 *   2. pos is outside listItem but DOM target is inside <li>: use posAtDOM
 *      to find the correct position and set selection there.
 *
 * @coordinates-with shared/listHelpers.ts — shared list item lookup and ancestor walk
 * @module plugins/listClickFix/tiptap
 */

import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { NodeType, ResolvedPos } from "@tiptap/pm/model";
import { listClickFixWarn } from "@/utils/debug";
import { findListItemType, isPositionInsideListItem } from "@/plugins/shared/listHelpers";

// Re-export for tests that import from this module
export { findListItemType, isPositionInsideListItem } from "@/plugins/shared/listHelpers";

/**
 * Check if a resolved position is inside a listItem whose text content
 * is empty (the <li> has no visible text). Walk up to find the listItem
 * ancestor, then check its textContent.
 */
export function isInsideEmptyListItem(
  $pos: ResolvedPos,
  listItemType: NodeType
): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type === listItemType) {
      return node.textContent.trim() === "";
    }
  }
  return false;
}

/**
 * Set selection inside an empty list item, inserting a paragraph first
 * if the listItem has no children (can happen with certain markdown parsers).
 * Returns true if selection was set, false if it couldn't be handled.
 */
export function setSelectionInEmptyListItem(
  view: EditorView,
  $pos: ResolvedPos,
  listItemType: NodeType
): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type !== listItemType) continue;

    if (node.childCount > 0) {
      // listItem has children — TextSelection.near can find a valid position
      const selection = TextSelection.near($pos);
      const tr = view.state.tr.setSelection(selection);
      view.dispatch(tr);
      return true;
    }

    // listItem has 0 children — insert an empty paragraph first
    const paragraphType = view.state.schema.nodes.paragraph;
    if (!paragraphType) return false;

    const insertPos = $pos.start(d);
    const tr = view.state.tr.insert(insertPos, paragraphType.create());
    // Cursor inside the new paragraph: insertPos + 1 (after paragraph open tag)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
    view.dispatch(tr);
    return true;
  }
  return false;
}

/** Exported for testing. */
export function handleClick(
  view: EditorView,
  pos: number,
  event: MouseEvent
): boolean {
  // Skip modified clicks — let multi-cursor and other handlers process them
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }

  const target = event.target;
  if (!(target instanceof Element)) return false;

  // Check if the DOM click target is inside an <li>
  const liElement = target.closest("li");
  if (!liElement) return false;

  const listItemType = findListItemType(view.state.schema);
  /* v8 ignore next -- @preserve schema always has listItem in editor; missing type is defensive */
  if (!listItemType) return false;

  const $pos = view.state.doc.resolve(pos);

  // Scenario 1: pos is inside an empty listItem — force-set selection.
  // For empty list items, PM's default behavior will read the browser's
  // native selection which resolves to the wrong place.
  if (isPositionInsideListItem($pos, listItemType) && isInsideEmptyListItem($pos, listItemType)) {
    return setSelectionInEmptyListItem(view, $pos, listItemType);
  }

  // Scenario 2: pos may be in a parent non-empty listItem (for nested empty items),
  // or outside list entirely. Check the DOM target's <li> for the correct position.
  try {
    const targetPos = view.posAtDOM(liElement, 0);
    const $targetPos = view.state.doc.resolve(targetPos);

    // Verify corrected position is actually inside an empty list item
    /* v8 ignore next -- @preserve DOM target outside list item after posAtDOM remap is a defensive edge case */
    if (!isPositionInsideListItem($targetPos, listItemType)) return false;
    if (!isInsideEmptyListItem($targetPos, listItemType)) return false;

    return setSelectionInEmptyListItem(view, $targetPos, listItemType);
  } catch (error) {
    /* v8 ignore start -- @preserve posAtDOM throws only for detached DOM nodes; not reproducible in unit tests */
    listClickFixWarn("posAtDOM failed for list click fix:", error);
    return false;
    /* v8 ignore stop */
  }
}

export const listClickFixExtension = Extension.create({
  name: "listClickFix",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick,
        },
      }),
    ];
  },
});
