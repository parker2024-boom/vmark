/**
 * Test helpers that change whether a CodeMirror view counts as connected —
 * which, for the paste flow, is simply its DOM being attached.
 *
 * @coordinates-with plugins/codemirror/smartPasteImage.test.ts — the tests built on these
 * @module plugins/codemirror/__tests__/viewConnection
 */
import type { EditorView } from "@codemirror/view";

/** Detach the view's DOM, exactly what a closed tab or mode switch does. */
export function disconnect(view: EditorView): void {
  view.dom.remove();
}

/**
 * Script the answers the view's DOM gives to `isConnected`, in order, for the
 * synchronous gaps no real detach can land in (between the confirm guard and
 * the insert's own check). The last answer repeats.
 */
export function scriptConnected(view: EditorView, answers: boolean[]): void {
  let i = 0;
  Object.defineProperty(view.dom, "isConnected", {
    configurable: true,
    get: () => answers[Math.min(i++, answers.length - 1)],
  });
}
