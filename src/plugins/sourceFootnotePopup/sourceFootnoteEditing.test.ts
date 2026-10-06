/** Regression #1491: source footnote previews must not interrupt raw-text editing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useFootnotePopupStore as store } from "@/stores/footnotePopupStore";
import { createSourceFootnotePopupPlugin } from "./sourceFootnotePopupPlugin";

let view: EditorView;
let parent: HTMLElement;

function setup(doc: string, pos: number) {
  store.getState().closePopup();
  parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [createSourceFootnotePopupPlugin(store)],
    }),
  });
  // jsdom has no layout; keep detection, events, store and focus behavior real.
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ top: 20, bottom: 40, left: 20, right: 30 });
  view.focus();
}

function pointer(type: string) {
  view.contentDOM.dispatchEvent(new MouseEvent(type, { bubbles: true }));
}

/** Run the popup's hover/hide timers and its autofocus frame to completion. */
async function settle() {
  await vi.advanceTimersByTimeAsync(200);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  view?.destroy();
  parent?.remove();
  store.getState().closePopup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("source footnote editing", () => {
  it.each(["click", "mousemove"])("does not open on definition content via %s", async (event) => {
    const doc = "[^来源]: 中文参考文献 — العربية\n    continuation text";
    setup(doc, doc.indexOf("参考"));
    pointer(event);
    await settle();
    expect(store.getState().isOpen).toBe(false);
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.indexOf("参考"));
  });

  it.each(["click", "mousemove"])("does not open on a continuation line via %s", async (event) => {
    const doc = "[^1]: first line\n    continuation";
    setup(doc, doc.indexOf("continuation"));
    pointer(event);
    await settle();
    expect(store.getState().isOpen).toBe(false);
  });

  it.each(["click", "mousemove"])("keeps editor focus when a marker opens via %s", async (event) => {
    setup("See [^1]\n\n[^1]: content", 6);
    pointer(event);
    await settle();
    expect(store.getState().isOpen).toBe(true);
    expect(store.getState().content).toBe("content");
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.head).toBe(6);
    view.dispatch(view.state.replaceSelection("X"));
    expect(view.state.doc.toString()).toBe("See [^X1]\n\n[^1]: content");
  });

  it.each(["click", "mousemove"])("does not reopen over selected text via %s", async (event) => {
    setup("See [^1]\n\n[^1]: content", 6);
    view.dispatch({ selection: { anchor: 4, head: 8 } });
    pointer(event);
    await settle();
    expect(store.getState().isOpen).toBe(false);
    expect(view.state.sliceDoc(4, 8)).toBe("[^1]");
    expect(view.state.selection.main.from).toBe(4);
    expect(view.state.selection.main.to).toBe(8);
  });

  it("does not open when a secondary selection contains text", async () => {
    setup("See [^1]\n\n[^1]: content", 6);
    view.setState(EditorState.create({
      doc: view.state.doc,
      selection: EditorSelection.create([EditorSelection.cursor(6), EditorSelection.range(16, 20)]),
      extensions: [EditorState.allowMultipleSelections.of(true), createSourceFootnotePopupPlugin(store)],
    }));
    pointer("click");
    await settle();
    expect(store.getState().isOpen).toBe(false);
  });

  it("cancels a pending hover when a selection starts", async () => {
    setup("See [^1]", 6);
    pointer("mousemove");
    view.dispatch({ selection: { anchor: 4, head: 8 } });
    await settle();
    expect(store.getState().isOpen).toBe(false);
    expect(view.hasFocus).toBe(true);
  });

  it.each([true, false])("honors explicit autofocus, still open: %s", async (stayOpen) => {
    setup("See [^1]", 6);
    store.getState().openPopup("1", "content", { top: 20, bottom: 40, left: 20, right: 30 }, null, 4, true);
    if (!stayOpen) store.getState().closePopup();
    await settle();
    if (stayOpen) {
      expect(document.activeElement?.tagName).toBe("TEXTAREA");
    } else {
      expect(view.hasFocus).toBe(true);
    }
  });

  it.each(["[^1]:", "[^来源]: 中文", "[^עברית]: العربية"])("still previews definition marker %s", async (doc) => {
    setup(doc, 2);
    pointer("click");
    await settle();
    expect(store.getState().isOpen).toBe(true);
    expect(store.getState().definitionPos).toBe(0);
    expect(view.hasFocus).toBe(true);
  });
});
