/**
 * Source Copy-on-Select Plugin
 *
 * Purpose: Auto-copies selected text to clipboard on mouseup in Source mode,
 * matching the WYSIWYG copy-on-select behavior for consistent cross-mode UX.
 *
 * Key decisions:
 *   - copyFormat setting is not applicable — source mode text IS already markdown
 *   - Only fires on mouseup (not keyboard selection) to avoid clipboard spam
 *   - The selection is markdown and is copied as written: only the blank
 *     lines before it and the whitespace after it are trimmed. Trailing spaces
 *     on a line are a hard break or part of code, and blank lines inside a
 *     fence are code, so nothing inside is touched.
 *   - Gated by the copyOnSelect setting from settingsStore
 *
 * @coordinates-with plugins/shared/hostSettings.ts — reads copyOnSelect
 * @module plugins/codemirror/sourceCopyOnSelect
 */

import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { hostSettings } from "@/plugins/shared/hostSettings";
import { trimMarkdownForClipboard } from "@/plugins/markdownCopy/tiptap";
import { clipboardWarn } from "@/utils/debug";
import { errorMessage } from "@/utils/errorMessage";

/** Creates a CodeMirror plugin that auto-copies selected text to clipboard. */
export function createSourceCopyOnSelectPlugin(): Extension {
  return ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private destroyed = false;

      constructor(view: EditorView) {
        this.view = view;
        view.dom.addEventListener("mouseup", this.handleMouseUp);
      }

      handleMouseUp = () => {
        if (!hostSettings.copyOnSelect()) return;

        const view = this.view;
        requestAnimationFrame(() => {
          if (this.destroyed) return;

          const { from, to } = view.state.selection.main;
          if (from === to) return;

          const raw = view.state.sliceDoc(from, to);
          const text = trimMarkdownForClipboard(raw);
          if (text) {
            navigator.clipboard.writeText(text).catch((error: unknown) => {
              clipboardWarn("Clipboard write failed:", errorMessage(error));
            });
          }
        });
      };

      destroy() {
        this.destroyed = true;
        this.view.dom.removeEventListener("mouseup", this.handleMouseUp);
      }
    }
  );
}
