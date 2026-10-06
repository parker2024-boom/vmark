/**
 * The math-popup extension's wiring.
 *
 * The store arrives as an injected PORT rather than an import (ADR-015), so
 * this asserts the extension actually threads it to the view — the failure
 * that injection makes possible is passing the option and never using it.
 * The real MathPopupView runs: the proof the store arrived is that driving it
 * opens the popup with the store's latex.
 *
 * @coordinates-with plugins/mathPopup/tiptap.ts
 * @module plugins/mathPopup/tiptap.test
 */
import { afterEach, describe, it, expect } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { MathPopupState } from "./MathPopupView";
import { mathPopupExtension } from "./tiptap";

function pluginFor(store: unknown) {
  const plugins = mathPopupExtension.config.addProseMirrorPlugins!.call({
    name: "mathPopup",
    options: { store },
    storage: {},
    parent: null as never,
    editor: {} as never,
    type: "extension" as never,
  } as never) as { spec: { view?: (v: unknown) => { destroy(): void } } }[];
  return plugins[0];
}

function popupStore(): StoreApi<MathPopupState> {
  return createStore<MathPopupState>()((set) => ({
    isOpen: false,
    anchorRect: null,
    latex: "",
    nodePos: null,
    closePopup: () => set({ isOpen: false, anchorRect: null }),
    updateLatex: (latex: string) => set({ latex }),
  }));
}

/** An editor DOM inside the `.editor-container` the popup anchors to. */
function editorViewInContainer() {
  const host = document.createElement("div");
  host.className = "editor-container";
  const dom = document.createElement("div");
  dom.className = "ProseMirror";
  host.appendChild(dom);
  document.body.appendChild(host);
  return { dom, state: { doc: { nodeAt: () => null } }, dispatch: () => {}, focus: () => {} };
}

const anchorRect = { top: 200, left: 150, bottom: 220, right: 250 };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the injected store reaches the view", () => {
  it("opens the popup with the injected store's latex", () => {
    const store = popupStore();
    pluginFor(store).spec.view!(editorViewInContainer());

    store.setState({ isOpen: true, anchorRect, latex: "x^2 + \\alpha" });

    const input = document.querySelector<HTMLTextAreaElement>(".math-popup-input");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("x^2 + \\alpha");
  });

  it("destroys the view with the editor: the popup leaves the DOM and stops listening", () => {
    const store = popupStore();
    const handle = pluginFor(store).spec.view!(editorViewInContainer());
    store.setState({ isOpen: true, anchorRect, latex: "a" });
    expect(document.querySelector(".math-popup-input")).not.toBeNull();

    handle.destroy();
    expect(document.querySelector(".math-popup-input")).toBeNull();

    store.setState({ isOpen: false, anchorRect: null });
    store.setState({ isOpen: true, anchorRect, latex: "b" });
    expect(document.querySelector(".math-popup-input")).toBeNull();
  });
});

describe("a host that forgets the store is told so", () => {
  it("throws a NAMED error rather than crashing inside the view", () => {
    // There is no sensible default for "the state this popup drives", unlike a
    // setting. Failing loud at wiring time beats an undefined-property error
    // from somewhere in the DOM code.
    expect(() => pluginFor(undefined)).toThrow(/requires a `store` option/);
  });
});
