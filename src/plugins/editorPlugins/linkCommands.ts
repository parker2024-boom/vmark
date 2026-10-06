/**
 * Purpose: Link-related keyboard shortcut handlers for WYSIWYG mode.
 *
 * Exports:
 * - handleUnlinkShortcut: Remove link mark keeping text
 *
 * @coordinates-with editorPlugins.tiptap.ts (keymap builder binds this)
 * @coordinates-with syntaxReveal/marks.ts (findMarkRange)
 * @module plugins/editorPlugins/linkCommands
 */

import type { EditorView } from "@tiptap/pm/view";
import { findMarkRange } from "@/plugins/syntaxReveal/marks";

/**
 * Remove link from selection, keeping the text.
 */
export function handleUnlinkShortcut(view: EditorView): boolean {
  const { state, dispatch } = view;
  const linkMarkType = state.schema.marks.link;
  if (!linkMarkType) return false;

  const $from = state.selection.$from;

  // Check if cursor is in a link
  const linkMark = $from.marks().find((m) => m.type === linkMarkType);
  if (!linkMark) return false;

  // Find the link's full range
  const markRange = findMarkRange($from.pos, linkMark, $from.start(), $from.parent);
  if (!markRange) return false;

  // Remove the link mark (preventAutolink stops Tiptap's Link extension from re-adding it)
  const tr = state.tr
    .removeMark(markRange.from, markRange.to, linkMarkType)
    .setMeta("preventAutolink", true);
  dispatch(tr);
  view.focus();
  return true;
}
