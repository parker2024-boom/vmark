// WI-RA17C.3 — placement and listener wiring extracted from SourcePopupView keep its behaviour
// The real editor-bounds reader runs; jsdom has no layout engine, so the
// element rects it reads are stubbed (the layout boundary), not the reader.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { EditorView } from "@codemirror/view";

import { placeSourcePopup, setSourcePopupListeners } from "./sourcePopupPlacement";

const anchor = { top: 400, bottom: 420, left: 480, right: 520 };
const dimensions = { width: 200, height: 40, gap: 6, preferAbove: true };

/** Give an element a laid-out box (jsdom reports zeros). */
function layout(el: HTMLElement, box: { top: number; left: number; bottom: number; right: number }) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...box,
    width: box.right - box.left,
    height: box.bottom - box.top,
  } as DOMRect);
}

/** An editor 1000 px wide inside an 800 px tall editor container. */
function makeView(): { view: EditorView; root: HTMLElement } {
  const root = document.createElement("div");
  root.className = "editor-container";
  const dom = document.createElement("div");
  root.appendChild(dom);
  document.body.appendChild(root);
  layout(root, { top: 0, left: 0, bottom: 800, right: 1000 });
  layout(dom, { top: 0, left: 0, bottom: 800, right: 1000 });
  return { view: { dom } as unknown as EditorView, root };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("placeSourcePopup", () => {
  it("uses viewport coordinates when mounted on document.body", () => {
    const { view } = makeView();
    const container = document.createElement("div");
    placeSourcePopup(view, container, document.body, anchor, dimensions);
    // Centered on the anchor (500 - 100) and above it (400 - 40 - 6).
    expect(container.style.left).toBe("400px");
    expect(container.style.top).toBe("354px");
  });

  it("uses viewport coordinates when there is no host", () => {
    const { view } = makeView();
    const container = document.createElement("div");
    placeSourcePopup(view, container, null, anchor, dimensions);
    expect(container.style.top).toBe("354px");
  });

  it("converts to host-relative coordinates inside the editor container", () => {
    const { view, root } = makeView();
    layout(root, { top: 100, left: 50, bottom: 800, right: 1000 });
    root.scrollTop = 30;
    const container = document.createElement("div");
    placeSourcePopup(view, container, root, anchor, dimensions);
    expect(container.style.top).toBe(`${354 - 100 + root.scrollTop}px`);
    expect(container.style.left).toBe(`${400 - 50 + root.scrollLeft}px`);
  });

  it("keeps the popup inside the editor's horizontal bounds", () => {
    const { view } = makeView();
    const container = document.createElement("div");
    // Anchored at the editor's right edge: centering would overflow 1000 px.
    placeSourcePopup(view, container, document.body, { top: 400, bottom: 420, left: 980, right: 1000 }, dimensions);
    expect(parseFloat(container.style.left) + dimensions.width).toBeLessThanOrEqual(1000);
  });

  it("falls back to gap 6 and above-preference when the config omits them", () => {
    const { view } = makeView();
    const container = document.createElement("div");
    placeSourcePopup(view, container, document.body, anchor, { width: 200, height: 40 });
    expect(container.style.top).toBe("354px");
  });
});

describe("setSourcePopupListeners", () => {
  function handlers() {
    return { clickOutside: vi.fn(), keydown: vi.fn(), scroll: vi.fn(), tabNavigation: vi.fn() };
  }

  it("routes document, scroll and container events while attached", () => {
    const { view, root } = makeView();
    const container = document.createElement("div");
    root.appendChild(container);
    const h = handlers();
    setSourcePopupListeners(view, container, h, true);

    document.dispatchEvent(new MouseEvent("mousedown"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    root.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

    expect(h.clickOutside).toHaveBeenCalledTimes(1);
    expect(h.scroll).toHaveBeenCalledTimes(1);
    expect(h.tabNavigation).toHaveBeenCalledTimes(1);
    expect(h.keydown).toHaveBeenCalledTimes(1);
  });

  it("stops every route once detached", () => {
    const { view, root } = makeView();
    const container = document.createElement("div");
    root.appendChild(container);
    const h = handlers();
    setSourcePopupListeners(view, container, h, true);
    setSourcePopupListeners(view, container, h, false);

    document.dispatchEvent(new MouseEvent("mousedown"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    root.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it("tolerates an editor outside any editor container", () => {
    const dom = document.createElement("div");
    const view = { dom } as unknown as EditorView;
    const container = document.createElement("div");
    expect(() => setSourcePopupListeners(view, container, handlers(), true)).not.toThrow();
    expect(() => setSourcePopupListeners(view, container, handlers(), false)).not.toThrow();
  });
});
