/**
 * Multi-cursor input handling for ProseMirror — typing, backspace, and delete
 * across multiple cursors. The three share one frame (editEachRange): edits
 * are applied in reverse document order by rangeEdits.ts, then the selection
 * is rebuilt.
 * @module plugins/multiCursor/inputHandling
 */
import { Selection, SelectionRange } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { MultiSelection } from "@/plugins/shared/MultiSelection";
import { isImeKeyEvent } from "@/utils/imeGuard";
import {
  normalizeRangesWithPrimary,
  remapBackwardFlags,
} from "@/plugins/shared/rangeUtils";
import {
  handleMultiCursorHorizontal,
  type HorizontalUnit,
} from "./horizontalMovement";
import { handleMultiCursorEnter } from "./enterHandling";
import { editRangesFromEnd, type RangeEdit } from "./rangeEdits";

/** The range rebuilt in the edited document from its ends, each mapped through every edit. */
type RangeRemap = (doc: Node, from: number, to: number) => SelectionRange;

/**
 * The frame every per-cursor edit shares: merge overlapping ranges so each
 * edit targets a disjoint span, apply the edit from the end of the document
 * to the start so earlier positions stay valid, then rebuild the selection
 * from the remapped ranges, merging any that the edits made touch.
 *
 * @returns Transaction or null if not a MultiSelection
 */
function editEachRange(
  state: EditorState,
  edit: RangeEdit,
  remap: RangeRemap
): Transaction | null {
  const { selection } = state;

  if (!(selection instanceof MultiSelection)) {
    return null;
  }

  const preMerged = normalizeRangesWithPrimary(
    selection.ranges, state.doc, selection.primaryIndex, true
  );
  const edits = editRangesFromEnd(state, preMerged.ranges, edit);
  let { tr } = edits;

  const newRanges = preMerged.ranges.map((range, index) =>
    remap(tr.doc, edits.map(index, range.$from.pos), edits.map(index, range.$to.pos))
  );
  const merged = normalizeRangesWithPrimary(newRanges, tr.doc, preMerged.primaryIndex, true);
  tr = tr.setSelection(new MultiSelection(merged.ranges, merged.primaryIndex));
  tr = tr.setMeta("addToHistory", true);

  return tr;
}

/** Both ends of the range, mapped through the edits. */
const remapBothEnds: RangeRemap = (doc, from, to) =>
  new SelectionRange(doc.resolve(from), doc.resolve(to));

/** A cursor where the range started, mapped through the edits. */
const remapToCursor: RangeRemap = (doc, from) => {
  const $pos = doc.resolve(from);
  return new SelectionRange($pos, $pos);
};

/**
 * Delete a range's selection, or — for a cursor — the one character before
 * (`dir` -1) or after (`dir` 1) it within its textblock. Characters are
 * measured by Unicode code point, so a surrogate pair (emoji) goes as a whole.
 */
function deleteAtRange(state: EditorState, dir: -1 | 1): RangeEdit {
  return (tr, range) => {
    const from = range.$from.pos;
    const to = range.$to.pos;
    if (from !== to) {
      return tr.delete(from, to);
    }

    // Resolved in the pre-edit document: edits run end to start, so nothing
    // at or before this position has moved yet.
    const $pos = state.doc.resolve(from);
    const size = $pos.parent.content.size;
    if (dir < 0 ? $pos.parentOffset === 0 : $pos.parentOffset >= size) {
      return tr;
    }
    const neighbour =
      dir < 0
        ? [...$pos.parent.textBetween(0, $pos.parentOffset)].at(-1)
        : [...$pos.parent.textBetween($pos.parentOffset, size)].at(0);
    /* v8 ignore next -- @preserve reason: a neighbouring character always exists inside the textblock bounds checked above; defensive guard */
    const charLen = neighbour ? neighbour.length : 1;
    return dir < 0 ? tr.delete(from - charLen, from) : tr.delete(from, from + charLen);
  };
}

/**
 * Handle text input at all cursor positions.
 * Inserts text at cursors, replaces text in selections.
 *
 * @param state - Current editor state
 * @param text - Text to insert
 * @returns Transaction or null if not a MultiSelection
 */
export function handleMultiCursorInput(
  state: EditorState,
  text: string,
  options?: { isComposing?: boolean }
): Transaction | null {
  if (options?.isComposing) {
    return null;
  }
  return editEachRange(
    state,
    (tr, range) => tr.insertText(text, range.$from.pos, range.$to.pos),
    remapBothEnds
  );
}

/**
 * Handle backspace at all cursor positions.
 * Deletes selection or character before cursor.
 *
 * @param state - Current editor state
 * @returns Transaction or null if not a MultiSelection
 */
export function handleMultiCursorBackspace(
  state: EditorState
): Transaction | null {
  return editEachRange(state, deleteAtRange(state, -1), remapToCursor);
}

/**
 * Handle delete at all cursor positions.
 * Deletes selection or character after cursor.
 *
 * @param state - Current editor state
 * @returns Transaction or null if not a MultiSelection
 */
export function handleMultiCursorDelete(
  state: EditorState
): Transaction | null {
  return editEachRange(state, deleteAtRange(state, 1), remapToCursor);
}

/**
 * Handle arrow key movement for multi-cursor.
 * Moves or extends all cursors in the same direction.
 *
 * @param state - Current editor state
 * @param direction - Arrow key direction
 * @param extend - Whether to extend selection (Shift+Arrow)
 * @returns Transaction or null if not a MultiSelection
 */
/** Fallback line height (px) when coordsAtPos returns zero-height rect */
const DEFAULT_LINE_HEIGHT_PX = 20;

export function handleMultiCursorArrow(
  state: EditorState,
  direction: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  extend: boolean,
  view?: EditorView
): Transaction | null {
  const { selection, doc } = state;

  if (!(selection instanceof MultiSelection)) {
    return null;
  }

  const dir = direction === "ArrowLeft" || direction === "ArrowUp" ? -1 : 1;
  const isVertical = direction === "ArrowUp" || direction === "ArrowDown";

  const backwardFlags = selection.backward;
  const nextRanges = selection.ranges.map((range, i) => {
    // Non-empty selection without extend: collapse to start or end
    if (!extend && range.$from.pos !== range.$to.pos) {
      const collapsePos = dir < 0 ? range.$from.pos : range.$to.pos;
      const $pos = doc.resolve(collapsePos);
      return new SelectionRange($pos, $pos);
    }

    const isBackward = backwardFlags?.[i];
    const headPos = isBackward ? range.$from.pos : range.$to.pos;

    // Vertical movement: use coordinate-based placement when view is available
    if (isVertical && view) {
      const coords = view.coordsAtPos(headPos);
      const lineHeight = coords.bottom - coords.top || DEFAULT_LINE_HEIGHT_PX;
      const targetY = dir < 0
        ? coords.top - lineHeight / 2
        : coords.bottom + lineHeight / 2;
      const result = view.posAtCoords({ left: coords.left, top: targetY });
      if (!result) return range;
      const targetPos = result.pos;
      if (extend) {
        const anchorPos = isBackward ? range.$to.pos : range.$from.pos;
        const from = Math.min(anchorPos, targetPos);
        const to = Math.max(anchorPos, targetPos);
        return new SelectionRange(doc.resolve(from), doc.resolve(to));
      }
      const $pos = doc.resolve(targetPos);
      return new SelectionRange($pos, $pos);
    }

    // Horizontal movement or vertical fallback (no view)
    const startPos = isVertical ? headPos : Math.max(0, Math.min(doc.content.size, headPos + dir));
    const $head = doc.resolve(startPos);
    const found = Selection.findFrom($head, dir, true);

    if (!found) {
      return range;
    }

    const targetPos = dir < 0 ? found.from : found.to;
    if (extend) {
      const anchorPos = isBackward ? range.$to.pos : range.$from.pos;
      const from = Math.min(anchorPos, targetPos);
      const to = Math.max(anchorPos, targetPos);
      return new SelectionRange(doc.resolve(from), doc.resolve(to));
    }

    const $pos = doc.resolve(targetPos);
    return new SelectionRange($pos, $pos);
  });

  // Derive updated backward flags: compare original anchor to new head
  const newBackward = nextRanges.map((range, i) => {
    if (range.$from.pos === range.$to.pos) return false;
    /* v8 ignore next -- @preserve non-extend (collapsed) move always returns false; range equality checked above */
    if (!extend) return false;
    const origRange = selection.ranges[i];
    const anchorPos = backwardFlags?.[i] ? origRange.$to.pos : origRange.$from.pos;
    const headPos = range.$from.pos === anchorPos ? range.$to.pos
      : range.$to.pos === anchorPos ? range.$from.pos
      : /* v8 ignore next -- @preserve defensive fallback: SelectionRange always has anchor at from or to */ (dir < 0 ? range.$from.pos : range.$to.pos);
    return anchorPos > headPos;
  });

  const normalized = normalizeRangesWithPrimary(
    nextRanges,
    doc,
    selection.primaryIndex,
    extend
  );
  const remappedBackward = remapBackwardFlags(nextRanges, newBackward, normalized.ranges);
  const newSel = new MultiSelection(normalized.ranges, normalized.primaryIndex, remappedBackward);
  return state.tr.setSelection(newSel);
}

/** Subset of KeyboardEvent properties needed for multi-cursor key handling. */
export type MultiCursorKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "isComposing" | "keyCode" | "altKey" | "ctrlKey" | "metaKey"
>;

/**
 * Handle keydown events for multi-cursor selection.
 */
export function handleMultiCursorKeyDown(
  state: EditorState,
  event: MultiCursorKeyEvent,
  view?: EditorView
): Transaction | null {
  if (!(state.selection instanceof MultiSelection)) {
    return null;
  }

  if (isImeKeyEvent(event as KeyboardEvent)) {
    return null;
  }

  switch (event.key) {
    case "Enter":
      // Only handle bare Enter; let Shift+Enter (hard break) etc. fall through
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return null;
      }
      return handleMultiCursorEnter(state);
    case "Backspace":
      return handleMultiCursorBackspace(state);
    case "Delete":
      return handleMultiCursorDelete(state);
    case "ArrowLeft":
    case "ArrowRight": {
      const unit: HorizontalUnit = event.metaKey
        ? "line"
        : event.altKey || event.ctrlKey
          ? "word"
          : "char";
      return handleMultiCursorHorizontal(state, event.key, event.shiftKey, unit);
    }
    case "ArrowUp":
    case "ArrowDown":
      if (event.metaKey || event.altKey || event.ctrlKey) {
        return null;
      }
      return handleMultiCursorArrow(state, event.key, event.shiftKey, view);
    default:
      return null;
  }
}
