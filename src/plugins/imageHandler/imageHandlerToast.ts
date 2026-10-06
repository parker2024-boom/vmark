/**
 * Image Handler Toast Operations
 *
 * Purpose: The WYSIWYG side of image-path paste — detects pasted image paths
 * and hands them to the shared paste flow with this editor's way of pasting
 * text and inserting image nodes.
 *
 * Key decisions:
 *   - Validation, the confirmation toast, the text fallback and every user
 *     notice belong to plugins/shared/imagePasteResolve.ts, which Source mode
 *     uses too; nothing here decides what the user sees.
 *
 * @coordinates-with plugins/imageHandler/tiptap.ts — extension entry point
 * @coordinates-with plugins/imageHandler/imageHandlerUtils.ts — shared utilities
 * @coordinates-with plugins/imageHandler/imageHandlerInsert.ts — image insertion
 * @coordinates-with plugins/shared/imagePasteResolve.ts — the shared paste flow
 * @module plugins/imageHandler/imageHandlerToast
 */

import type { EditorView } from "@tiptap/pm/view";
import { offerImagePaste } from "@/plugins/shared/imagePasteResolve";
import { detectMultipleImagePaths } from "@/utils/imagePathDetection";
import { parseMultiplePaths } from "@/utils/multiImageParsing";
import { insertImageFromPath, insertMultipleImages, pasteAsText } from "./imageHandlerInsert";
import { imageHandlerWarn, imageHandlerError } from "@/utils/debug";
import { isViewConnected, getToastAnchorRect } from "./imageHandlerUtils";

/**
 * Check if pasted text is an image path and show toast.
 * Returns true if we're handling it (showing toast), false otherwise.
 * Supports both single and multiple image paths.
 */
export function tryTextImagePaste(view: EditorView, text: string): boolean {
  if (!text) return false;

  // Parse potential paths from clipboard text
  const { paths } = parseMultiplePaths(text);
  if (paths.length === 0) return false;

  // Check if ALL parsed items are valid images
  const detection = detectMultipleImagePaths(paths);
  if (!detection.allImages) return false;

  // Capture selection state at paste time; selected text becomes a single image's alt text
  const { from, to } = view.state.selection;
  const capturedAltText = from !== to ? view.state.doc.textBetween(from, to) : "";

  offerImagePaste(
    {
      editorDom: view.dom,
      isConnected: () => isViewConnected(view),
      anchorRect: () => getToastAnchorRect(view),
      pasteAsText: () => pasteAsText(view, text, from, to),
      insertSingle: (result) => insertImageFromPath(view, result, from, to, capturedAltText),
      insertMultiple: (results) => insertMultipleImages(view, results, from, to),
      log: { warn: imageHandlerWarn, error: imageHandlerError },
    },
    detection.results
  );
  return true;
}
