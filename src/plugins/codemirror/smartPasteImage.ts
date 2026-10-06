/**
 * Smart Paste Image Handling
 *
 * Purpose: The Source-mode side of image-path paste — detects pasted image
 * paths, hands them to the shared paste flow, and writes the confirmed
 * image(s) into the document as markdown.
 *
 * Pipeline: detect image paths -> offerImagePaste (validate, confirm, notify)
 *   -> resolve paths (copy to assets per the user's setting) -> insert markdown
 *
 * Key decisions:
 *   - Validation, the confirmation toast, the text fallback and every user
 *     notice belong to plugins/shared/imagePasteResolve.ts, which WYSIWYG uses
 *     too; this module only knows how to edit a CodeMirror document.
 *   - A single image takes its alt text from the selection, or from the word
 *     under the cursor; a batch has none.
 *
 * @coordinates-with smartPaste.ts — plugin factory
 * @coordinates-with smartPasteUtils.ts — view helpers and text fallback
 * @coordinates-with plugins/shared/imagePasteResolve.ts — the shared paste flow
 * @module plugins/codemirror/smartPasteImage
 */

import { EditorView } from "@codemirror/view";
import { copyImageToAssets } from "@/services/media/imageOperations";
import { hostSettings } from "@/plugins/shared/hostSettings";
import {
  offerImagePaste,
  resolveImagePathsForInsert,
  type ImageInsertHost,
} from "@/plugins/shared/imagePasteResolve";
import { smartPasteWarn, smartPasteError } from "@/utils/debug";
import { detectMultipleImagePaths, type ImagePathResult } from "@/utils/imagePathDetection";
import { encodeMarkdownUrl } from "@/utils/markdownUrl";
import { parseMultiplePaths } from "@/utils/multiImageParsing";
import { findWordAtCursorSource } from "@/plugins/toolbarActions/sourceAdapterLinks";
import {
  isViewConnected,
  getActiveFilePath,
  getToastAnchorRect,
  pasteAsText,
} from "./smartPasteUtils";

function insertHost(): ImageInsertHost {
  return {
    documentPath: getActiveFilePath(),
    copyToAssets: hostSettings.copyImagesToAssets(),
    copyImage: copyImageToAssets,
    logError: smartPasteError,
  };
}

/**
 * Insert the confirmed image(s) as markdown, one `![alt](path)` per line.
 * Takes the range captured at paste time; if the selection moved while the
 * paths were being resolved, the current selection is replaced instead.
 */
async function insertImagesAsMarkdown(
  view: EditorView,
  results: ImagePathResult[],
  capturedFrom: number,
  capturedTo: number,
  altText: string
): Promise<void> {
  if (!isViewConnected(view)) {
    smartPasteWarn("View disconnected, aborting image insert");
    return;
  }

  const imagePaths = await resolveImagePathsForInsert(results, insertHost());
  if (imagePaths === null) return;

  if (!isViewConnected(view)) {
    smartPasteWarn("View disconnected after async, aborting image insert");
    return;
  }

  const { from: currentFrom, to: currentTo } = view.state.selection.main;
  const selectionChanged = currentFrom !== capturedFrom || currentTo !== capturedTo;
  if (selectionChanged) {
    smartPasteWarn("Selection changed during async, using current position");
  }

  // Clamp to the document: it may have shrunk while the paths were resolved.
  const docLength = view.state.doc.length;
  const insertFrom = Math.min(selectionChanged ? currentFrom : capturedFrom, docLength);
  const insertTo = Math.min(selectionChanged ? currentTo : capturedTo, docLength);

  const markdown = imagePaths.map((p) => `![${altText}](${encodeMarkdownUrl(p)})`).join("\n");
  view.dispatch({
    changes: { from: insertFrom, to: insertTo, insert: markdown },
    selection: { anchor: insertFrom + markdown.length },
  });
  view.focus();
}

/**
 * Check if pasted text is an image path and handle accordingly.
 * Returns true if handled (showing toast or async validation started).
 * Supports both single and multiple image paths.
 * @param originalText - The original pasted text (untrimmed) for fallback paste
 */
export function tryImagePaste(view: EditorView, originalText: string): boolean {
  if (!originalText) return false;

  // Parse potential paths from clipboard text
  const { paths } = parseMultiplePaths(originalText);
  if (paths.length === 0) return false;

  // Check if ALL parsed items are valid images
  const detection = detectMultipleImagePaths(paths);
  if (!detection.allImages) return false;

  // Capture selection state at paste time
  const { from, to } = view.state.selection.main;

  // The range the image replaces, and the alt text a single image takes from it
  let altText = "";
  let insertFrom = from;
  let insertTo = to;

  if (from !== to) {
    // Has selection: use as alt text
    altText = view.state.doc.sliceString(from, to);
  } else {
    // No selection: try word expansion for alt text
    const wordRange = findWordAtCursorSource(view, from);
    if (wordRange) {
      altText = view.state.doc.sliceString(wordRange.from, wordRange.to);
      insertFrom = wordRange.from;
      insertTo = wordRange.to;
    }
  }

  offerImagePaste(
    {
      editorDom: view.dom,
      isConnected: () => isViewConnected(view),
      anchorRect: () => getToastAnchorRect(view, insertFrom),
      pasteAsText: () => pasteAsText(view, originalText, insertFrom, insertTo),
      insertSingle: (result) => insertImagesAsMarkdown(view, [result], insertFrom, insertTo, altText),
      insertMultiple: (results) => insertImagesAsMarkdown(view, results, insertFrom, insertTo, ""),
      log: { warn: smartPasteWarn, error: smartPasteError },
    },
    detection.results
  );
  return true;
}
