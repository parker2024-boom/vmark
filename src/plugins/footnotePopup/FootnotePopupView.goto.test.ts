/**
 * The popup's "go to definition" button (#1506), against a live ProseMirror
 * state.
 *
 * The bug lived in the ORDER of three side effects: the button started a
 * smooth scroll and then focused the editor, and in WebKit focusing the editor
 * cancels a smooth scroll already in flight — so the click did nothing. The
 * real-engine proof is FootnotePopupView.goto.webkit.test.ts; this file pins
 * the order (caret into the definition, focus, THEN scroll) in the jsdom tier
 * that every change runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { FootnotePopupState } from "@/plugins/shared/popupPorts";
import { FootnotePopupView } from "./FootnotePopupView";

const schema = new Schema({
  nodes: {
    doc: { content: "(block | footnote_definition)+" },
    paragraph: { group: "block", content: "inline*" },
    footnote_reference: { group: "inline", inline: true, atom: true, attrs: { label: { default: "1" } } },
    footnote_definition: { content: "block+", attrs: { label: { default: "1" } } },
    text: { group: "inline" },
  },
});

/** `Intro[^1]` / `Middle` / `[^1]: Note text` */
function buildDoc() {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("Intro"), schema.node("footnote_reference", { label: "1" })]),
    schema.node("paragraph", null, [schema.text("Middle")]),
    schema.node("footnote_definition", { label: "1" }, [schema.node("paragraph", null, [schema.text("Note text")])]),
  ]);
}

function definitionPos(state: EditorState): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "footnote_definition") found = pos;
    return found < 0;
  });
  return found;
}

/** Each side effect the goto button causes, in the order it happened. */
let events: string[];
let state: EditorState;
let editorContainer: HTMLElement;
let scroller: HTMLElement;
let popup: FootnotePopupView;
let storeState: FootnotePopupState;
const listeners = new Set<(s: FootnotePopupState) => void>();

const store = {
  getState: () => storeState,
  subscribe: (fn: (s: FootnotePopupState) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function setStore(partial: Partial<FootnotePopupState>) {
  storeState = { ...storeState, ...partial };
  listeners.forEach((fn) => fn(storeState));
}

function createView(): EditorView {
  editorContainer = document.createElement("div");
  editorContainer.className = "editor-container";
  scroller = document.createElement("div");
  scroller.className = "editor-content";
  scroller.scrollTo = vi.fn(() => { events.push("scroll"); }) as unknown as typeof scroller.scrollTo;
  const editorDom = document.createElement("div");
  editorDom.className = "ProseMirror";
  scroller.appendChild(editorDom);
  editorContainer.appendChild(scroller);
  document.body.appendChild(editorContainer);

  state = EditorState.create({ doc: buildDoc(), schema });
  return {
    dom: editorDom,
    get state() { return state; },
    dispatch: (tr: Transaction) => {
      events.push(tr.selectionSet ? "select" : "dispatch");
      state = state.apply(tr);
    },
    focus: () => { events.push("focus"); },
    coordsAtPos: () => ({ top: 900, bottom: 920, left: 0, right: 0 }),
  } as unknown as EditorView;
}

beforeEach(() => {
  events = [];
  listeners.clear();
  storeState = {
    isOpen: false, label: "", content: "", anchorRect: null,
    definitionPos: null, referencePos: null, autoFocus: false,
    openPopup: vi.fn(), setContent: vi.fn(),
    closePopup: vi.fn(() => { events.push("close"); setStore({ isOpen: false, anchorRect: null }); }),
  } as unknown as FootnotePopupState;
  popup = new FootnotePopupView(createView(), store);
});

afterEach(() => {
  popup.destroy();
  editorContainer.remove();
});

function clickGoto(definitionAt: number | null) {
  setStore({
    isOpen: true, label: "1", content: "Note text",
    anchorRect: { top: 10, bottom: 30, left: 10, right: 40 },
    definitionPos: definitionAt, referencePos: 6,
  });
  editorContainer.querySelector<HTMLElement>(".footnote-popup-btn-goto")!.click();
}

describe("FootnotePopupView go-to-definition (#1506)", () => {
  it("puts the caret in the definition, focuses, and only then scrolls", () => {
    const defPos = definitionPos(state);
    clickGoto(defPos);

    // Focus after the scroll started cancelled it in WebKit — scroll comes last.
    expect(events).toEqual(["close", "select", "focus", "scroll"]);

    const { $from } = state.selection;
    expect($from.node(-1).type.name).toBe("footnote_definition");
    expect($from.parent.textContent).toBe("Note text");
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("still lands on the definition when the stored position went stale", () => {
    clickGoto(1); // inside the first paragraph, not a definition

    expect(events).toEqual(["close", "select", "focus", "scroll"]);
    expect(state.selection.$from.node(-1).type.name).toBe("footnote_definition");
  });

  it("does nothing when the popup has no definition to go to", () => {
    clickGoto(null);

    expect(events).toEqual([]);
    expect(storeState.isOpen).toBe(true);
  });
});
