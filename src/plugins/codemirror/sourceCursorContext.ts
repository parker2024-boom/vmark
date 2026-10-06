/**
 * Source cursor context — a CodeMirror update listener that publishes the
 * cursor's formatting context from the active source view to the host.
 *
 * @module plugins/codemirror/sourceCursorContext
 */

import { EditorView } from "@codemirror/view";
import { hostEditors } from "@/plugins/shared/hostEditors";
import { computeSourceCursorContext } from "@/plugins/sourceContextDetection/cursorContext";

/**
 * Creates a CodeMirror plugin that publishes the source cursor context on
 * selection and document changes.
 *
 * Only the ACTIVE source view publishes. In a split, a
 * non-markdown pane taking focus drops the markdown pane's context so the
 * toolbar and context menu — which act on `source.editorView` — cannot format
 * a document the user left; an unfocused view re-publishing on its next update
 * undid that.
 */
export function createSourceCursorContextPlugin() {
  return EditorView.updateListener.of((update) => {
    if (hostEditors.activeSourceView() !== update.view) return;
    /* v8 ignore next -- @preserve short-circuit branches and else path not all covered in tests */
    if (
      hostEditors.source().editorView !== update.view ||
      update.selectionSet ||
      update.docChanged
    ) {
      hostEditors.reportSourceContext(computeSourceCursorContext(update.view), update.view);
    }
  });
}
