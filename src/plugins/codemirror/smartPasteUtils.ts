/**
 * Smart Paste Utilities
 *
 * Purpose: Pure/small helper functions used by the smart paste plugin and image handling.
 *
 * @coordinates-with smartPaste.ts — plugin factory
 * @coordinates-with smartPasteImage.ts — image paste handling
 * @module plugins/codemirror/smartPasteUtils
 */

import { EditorView } from "@codemirror/view";
import { getWindowLabel } from "@/services/navigation/windowFocus";
import { hostDocument } from "@/plugins/shared/hostDocument";
import { isViewConnected } from "@/plugins/shared/imagePasteResolve";

// The connectivity check is shared with WYSIWYG; re-exported for this cluster.
export { isViewConnected };

/**
 * Check if a string looks like a valid URL.
 */
export function isValidUrl(str: string): boolean {
  const trimmed = str.trim();
  // Must start with http:// or https:// and contain no spaces
  return /^https?:\/\/\S+$/.test(trimmed);
}

/**
 * Get the active document file path for the current window.
 */
export function getActiveFilePath(): string | null {
  try {
    const windowLabel = getWindowLabel();
    return hostDocument.activeFilePath(windowLabel);
  } catch {
    return null;
  }
}

/**
 * Get anchor rect for toast positioning based on cursor position.
 */
export function getToastAnchorRect(view: EditorView, pos: number): { top: number; left: number; bottom: number; right: number } {
  try {
    const coords = view.coordsAtPos(pos);
    if (coords) {
      return {
        top: coords.top,
        left: coords.left,
        bottom: coords.bottom,
        right: coords.right,
      };
    }
  } catch {
    // Fallback
  }
  return {
    top: window.innerHeight / 2 - 20,
    left: window.innerWidth / 2,
    bottom: window.innerHeight / 2,
    right: window.innerWidth / 2,
  };
}

/**
 * Paste text as plain text.
 * Uses captured positions to handle async timing.
 */
export function pasteAsText(view: EditorView, text: string, capturedFrom: number, capturedTo: number): void {
  if (!isViewConnected(view)) {
    return;
  }

  // Use captured positions if selection hasn't changed, otherwise use current
  const { from: currentFrom, to: currentTo } = view.state.selection.main;
  const docLength = view.state.doc.length;
  const from = currentFrom === capturedFrom && currentTo === capturedTo
    ? Math.min(capturedFrom, docLength)
    : Math.min(currentFrom, docLength);
  const to = currentFrom === capturedFrom && currentTo === capturedTo
    ? Math.min(capturedTo, docLength)
    : Math.min(currentTo, docLength);

  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  view.focus();
}
