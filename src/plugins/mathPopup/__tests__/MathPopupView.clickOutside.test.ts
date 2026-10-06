// WI-RA9A.1 — clicking away from the WYSIWYG math popup commits the edit.
/**
 * The Source math popup has always saved on click-outside; the WYSIWYG one
 * discarded what the user typed. These tests run the view against a real
 * ProseMirror document so "committed" means the node's attribute changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";

vi.mock("@/plugins/shared/katexLoader", () => ({
  loadKatex: () => Promise.resolve({ default: { render: () => {} } }),
}));

import { MathPopupView, type MathPopupState } from "../MathPopupView";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    math_inline: { inline: true, group: "inline", atom: true, attrs: { content: { default: "" } } },
  },
});

const ANCHOR = { top: 200, left: 150, bottom: 220, right: 250 };

function setup(initialLatex: string) {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [
      schema.text("a "),
      schema.nodes.math_inline.create({ content: initialLatex }),
      schema.text(" b"),
    ]),
  ]);
  const mathPos = 3;
  const transactions: Transaction[] = [];
  const editorDom = document.createElement("div");
  document.body.appendChild(editorDom);
  const view = {
    dom: editorDom,
    state: EditorState.create({ schema, doc }),
    dispatch(tr: Transaction) {
      transactions.push(tr);
      view.state = view.state.apply(tr);
    },
    focus: vi.fn(),
  };

  const listeners = new Set<(state: MathPopupState) => void>();
  let state: MathPopupState = {
    isOpen: false,
    anchorRect: null,
    latex: "",
    nodePos: null,
    updateLatex: (latex) => set({ latex }),
    closePopup: () => set({ isOpen: false, anchorRect: null, nodePos: null }),
  };
  function set(next: Partial<MathPopupState>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener(state));
  }
  const store = {
    getState: () => state,
    subscribe: (listener: (s: MathPopupState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const popup = new MathPopupView(
    view,
    // The view reads only getState/subscribe; zustand's StoreApi asks for more.
    store as unknown as ConstructorParameters<typeof MathPopupView>[1]
  );
  const open = () => set({ isOpen: true, anchorRect: ANCHOR, latex: initialLatex, nodePos: mathPos });
  const type = (latex: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".math-popup-input");
    if (!textarea) throw new Error("math popup textarea not mounted");
    textarea.value = latex;
    textarea.dispatchEvent(new Event("input"));
    return textarea;
  };
  const mathContent = () => view.state.doc.nodeAt(mathPos)?.attrs.content;

  return { view, popup, store, open, type, mathContent, transactions, mathPos };
}

function mousedownOn(target: Element) {
  const event = new MouseEvent("mousedown", { bubbles: true });
  Object.defineProperty(event, "target", { value: target });
  document.dispatchEvent(event);
}

describe("MathPopupView — click outside", () => {
  let outside: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    // The base class ignores the click that opened the popup for one frame.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    outside = document.createElement("div");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["ascii", "a^2 + b^2"],
    ["CJK", "\\text{面积} = \\pi r^2"],
    ["multi-line", "a\n+ b"],
    ["emptied", ""],
  ])("commits the typed latex (%s) to the math node and closes", (_label, latex) => {
    const t = setup("before");
    document.body.appendChild(outside);
    t.open();
    t.type(latex);

    mousedownOn(outside);

    expect(t.mathContent()).toBe(latex);
    expect(t.transactions).toHaveLength(1);
    expect(t.store.getState().isOpen).toBe(false);
    t.popup.destroy();
  });

  it("closes without a transaction when nothing was changed", () => {
    const t = setup("x^2");
    document.body.appendChild(outside);
    t.open();

    mousedownOn(outside);

    expect(t.transactions).toEqual([]);
    expect(t.mathContent()).toBe("x^2");
    expect(t.store.getState().isOpen).toBe(false);
    t.popup.destroy();
  });

  it("closes without a transaction when the math node is gone by then", () => {
    const t = setup("before");
    document.body.appendChild(outside);
    t.open();
    t.type("after");
    t.view.state = t.view.state.apply(t.view.state.tr.delete(t.mathPos, t.mathPos + 1));

    mousedownOn(outside);

    expect(t.transactions).toEqual([]);
    expect(t.store.getState().isOpen).toBe(false);
    t.popup.destroy();
  });

  it("keeps the popup open, uncommitted, for a click inside it", () => {
    const t = setup("before");
    document.body.appendChild(outside);
    t.open();
    const textarea = t.type("after");

    mousedownOn(textarea);

    expect(t.mathContent()).toBe("before");
    expect(t.store.getState().isOpen).toBe(true);
    t.popup.destroy();
  });

  it("commits once when the outside click is repeated", () => {
    const t = setup("before");
    document.body.appendChild(outside);
    t.open();
    t.type("after");

    mousedownOn(outside);
    mousedownOn(outside);

    expect(t.transactions).toHaveLength(1);
    expect(t.mathContent()).toBe("after");
    t.popup.destroy();
  });

  it("still discards the edit on Escape", () => {
    const t = setup("before");
    document.body.appendChild(outside);
    t.open();
    const textarea = t.type("discard me");

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(t.mathContent()).toBe("before");
    expect(t.transactions).toEqual([]);
    expect(t.store.getState().isOpen).toBe(false);
    t.popup.destroy();
  });
});
