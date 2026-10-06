/**
 * Image Handler Insert Operations
 *
 * Purpose: Functions for inserting images into the editor —
 * single image insertion, multiple image insertion, and plain text fallback.
 *
 * @coordinates-with plugins/imageHandler/tiptap.ts — extension entry point
 * @coordinates-with plugins/imageHandler/imageHandlerUtils.ts — shared utilities
 * @coordinates-with plugins/imageHandler/imageHandlerToast.ts — toast UI
 * @coordinates-with services/media/imageOperations.ts — copyImageToAssets, insertBlockImageNode
 * @coordinates-with plugins/shared/imagePasteResolve.ts — path resolution shared with Source mode
 * @module plugins/imageHandler/imageHandlerInsert
 */

import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import i18n from "@/i18n";
import { copyImageToAssets, insertBlockImageNode } from "@/services/media/imageOperations";
import { hostNotify } from "@/plugins/shared/hostNotify";
import { hostSettings } from "@/plugins/shared/hostSettings";
import {
  resolveImagePathForInsert,
  resolveImagePathsForInsert,
  type ImageInsertHost,
} from "@/plugins/shared/imagePasteResolve";
import type { ImagePathResult } from "@/utils/imagePathDetection";
import { imageHandlerWarn, imageHandlerError } from "@/utils/debug";
import { isViewConnected, getActiveFilePathForCurrentWindow } from "./imageHandlerUtils";

/** What resolving a confirmed image needs from the host, read at insert time. */
function insertHost(): ImageInsertHost {
  return {
    documentPath: getActiveFilePathForCurrentWindow(),
    copyToAssets: hostSettings.copyImagesToAssets(),
    copyImage: copyImageToAssets,
    logError: imageHandlerError,
  };
}

/**
 * Insert image from text path (after user confirmation).
 * Takes captured selection to handle async timing.
 * Uses captured selection text as alt text if available.
 */
export async function insertImageFromPath(
  view: EditorView,
  detection: ImagePathResult,
  capturedFrom: number,
  capturedTo: number,
  capturedAltText: string
): Promise<void> {
  // Verify view is still connected
  if (!isViewConnected(view)) {
    imageHandlerWarn("View disconnected, aborting image insert");
    return;
  }

  const imagePath = await resolveImagePathForInsert(detection, insertHost());
  if (imagePath === null) return;

  // Re-verify view is still connected after async operations
  if (!isViewConnected(view)) {
    imageHandlerWarn("View disconnected after async, aborting image insert");
    return;
  }

  // Restore selection to captured position if we have alt text to use
  // This ensures the selected text gets replaced
  if (capturedAltText && capturedFrom !== capturedTo) {
    const { state, dispatch } = view;
    const maxPos = state.doc.content.size;
    const safeFrom = Math.min(capturedFrom, maxPos);
    const safeTo = Math.min(capturedTo, maxPos);
    if (safeFrom < safeTo) {
      const tr = state.tr.setSelection(
        TextSelection.create(state.doc, safeFrom, safeTo)
      );
      dispatch(tr);
    }
  }

  // Insert the image node with captured alt text
  insertBlockImageNode(view, imagePath, capturedAltText);
}

/**
 * Insert multiple images as block nodes.
 */
export async function insertMultipleImages(
  view: EditorView,
  results: ImagePathResult[],
  _capturedFrom: number,
  _capturedTo: number
): Promise<void> {
  // Verify view is still connected
  if (!isViewConnected(view)) {
    imageHandlerWarn("View disconnected, aborting multi-image insert");
    return;
  }

  const imagePaths = await resolveImagePathsForInsert(results, insertHost());
  if (imagePaths === null) return;

  // Re-verify view is still connected after async operations
  if (!isViewConnected(view)) {
    imageHandlerWarn("View disconnected after async, aborting image insert");
    return;
  }

  if (imagePaths.length === 0) return;

  // Insert all images in a single transaction with correct position tracking
  const { state } = view;
  const blockImageType = state.schema.nodes.block_image;
  if (!blockImageType) {
    imageHandlerWarn("block_image node type not found");
    hostNotify.error(i18n.t("dialog:toast.imageSchemaUnavailable"));
    return;
  }

  // Find insertion point from current selection
  const { $from } = state.selection;
  let currentInsertPos = $from.end($from.depth) + 1;
  currentInsertPos = Math.min(currentInsertPos, state.doc.content.size);

  let tr = state.tr;
  for (const imagePath of imagePaths) {
    const imageNode = blockImageType.create({
      src: imagePath,
      alt: "",
      title: "",
    });

    tr = tr.insert(currentInsertPos, imageNode);
    // Move insert position forward by size of inserted node
    currentInsertPos += imageNode.nodeSize;
  }

  view.dispatch(tr);
}

/**
 * Paste text as plain text (default paste behavior).
 * Uses captured positions to handle async timing.
 */
export function pasteAsText(view: EditorView, text: string, capturedFrom: number, capturedTo: number): void {
  if (!isViewConnected(view)) {
    return;
  }

  const { state, dispatch } = view;

  // Use current selection if it matches captured, otherwise use current
  const { from: currentFrom, to: currentTo } = state.selection;
  const from = currentFrom === capturedFrom && currentTo === capturedTo ? capturedFrom : currentFrom;
  const to = currentFrom === capturedFrom && currentTo === capturedTo ? capturedTo : currentTo;

  const tr = state.tr.insertText(text, from, to);
  dispatch(tr);
  view.focus();
}
