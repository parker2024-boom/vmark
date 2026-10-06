/**
 * CodeMirror IME guard — a view plugin that marks the end of an IME
 * composition on `compositionend` or blur, then flushes the queued
 * composition work on the next frame.
 *
 * @module plugins/codemirror/imeGuard
 */

import { EditorView, ViewPlugin } from "@codemirror/view";
import { flushCodeMirrorCompositionQueue, markCodeMirrorCompositionEnd } from "@/utils/imeGuard";

/** Creates a CodeMirror plugin that tracks IME composition state for safe key handling. */
export function createImeGuardPlugin() {
  return ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private handleCompositionEnd = () => {
        markCodeMirrorCompositionEnd(this.view);
        requestAnimationFrame(() => {
          flushCodeMirrorCompositionQueue(this.view);
        });
      };

      constructor(view: EditorView) {
        this.view = view;
        this.view.dom.addEventListener("compositionend", this.handleCompositionEnd);
        this.view.dom.addEventListener("blur", this.handleCompositionEnd);
      }

      destroy() {
        this.view.dom.removeEventListener("compositionend", this.handleCompositionEnd);
        this.view.dom.removeEventListener("blur", this.handleCompositionEnd);
      }
    }
  );
}
