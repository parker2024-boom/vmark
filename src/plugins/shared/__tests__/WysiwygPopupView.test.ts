/**
 * Tests for WysiwygPopupView base class.
 *
 * Uses a concrete subclass to test the abstract class methods:
 * lifecycle, show/hide, click-outside, keyboard, scroll, destroy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/utils/popupPosition", () => ({
  calculatePopupPosition: vi.fn(() => ({ top: 100, left: 200 })),
  getBoundaryRects: vi.fn(() => ({
    top: 0,
    left: 0,
    bottom: 800,
    right: 1200,
    width: 1200,
    height: 800,
  })),
  getViewportBounds: vi.fn(() => ({
    top: 0,
    left: 0,
    bottom: 800,
    right: 1200,
    width: 1200,
    height: 800,
  })),
}));

vi.mock("@/utils/popupComponents", () => ({
  handlePopupTabNavigation: vi.fn(),
}));

vi.mock("@/utils/imeGuard", () => ({
  isImeKeyEvent: vi.fn(() => false),
}));

import { WysiwygPopupView } from "../WysiwygPopupView";
import type { PopupStoreBase, StoreApi, EditorViewLike } from "../types";
import type { AnchorRect } from "@/utils/popupPosition";
import { isImeKeyEvent } from "@/utils/imeGuard";

/* ------------------------------------------------------------------ */
/*  Test subclass                                                      */
/* ------------------------------------------------------------------ */

interface TestState extends PopupStoreBase {
  value: string;
}

class TestPopupView extends WysiwygPopupView<TestState> {
  public onShowCalled = false;
  public onHideCalled = false;
  public builtContainer!: HTMLElement;

  protected buildContainer(): HTMLElement {
    const el = document.createElement("div");
    el.className = "test-popup";
    const input = document.createElement("input");
    el.appendChild(input);
    this.builtContainer = el;
    return el;
  }

  protected onShow(_state: TestState): void {
    this.onShowCalled = true;
  }

  protected onHide(): void {
    this.onHideCalled = true;
  }

  // Expose protected methods for testing
  public testIsVisible(): boolean {
    return this.isVisible();
  }

  public getContainer(): HTMLElement {
    return this.container;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** An editor DOM mounted in `parent` (a real `.editor-container` by default). */
function createEditorView(parent: HTMLElement | null = createEditorContainer()): EditorViewLike {
  const dom = document.createElement("div");
  parent?.appendChild(dom);

  return {
    dom,
    state: {} as never,
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}

function createEditorContainer(): HTMLElement {
  const editorContainer = document.createElement("div");
  editorContainer.className = "editor-container";
  document.body.appendChild(editorContainer);
  return editorContainer;
}

const ANCHOR: AnchorRect = { top: 50, left: 100, bottom: 70, right: 110 };

function createStore(initial: TestState): StoreApi<TestState> & { listeners: Set<(s: TestState) => void>; setState: (s: TestState) => void } {
  let state = initial;
  const listeners = new Set<(s: TestState) => void>();

  return {
    getState: () => state,
    subscribe: (listener: (s: TestState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listeners,
    setState: (newState: TestState) => {
      state = newState;
      listeners.forEach((l) => l(state));
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("WysiwygPopupView", () => {
  let view: TestPopupView;
  let editorView: EditorViewLike;
  let store: ReturnType<typeof createStore>;

  const closeFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    editorView = createEditorView();
    store = createStore({
      isOpen: false,
      anchorRect: null,
      closePopup: closeFn,
      value: "test",
    });
    view = new TestPopupView(editorView, store);
  });

  afterEach(() => {
    view.destroy();
    document.body.textContent = "";
  });

  it("starts hidden", () => {
    expect(view.testIsVisible()).toBe(false);
    expect(view.getContainer().style.display).toBe("none");
  });

  it("shows when store emits isOpen=true with anchorRect", () => {
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "test",
    });

    expect(view.getContainer().style.display).toBe("flex");
    expect(view.onShowCalled).toBe(true);
  });

  it("hides when store emits isOpen=false after being open", () => {
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "open",
    });

    store.setState({
      isOpen: false,
      anchorRect: null,
      closePopup: closeFn,
      value: "closed",
    });

    expect(view.getContainer().style.display).toBe("none");
    expect(view.onHideCalled).toBe(true);
  });

  it("does not call onShow when already open and store updates", () => {
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "first",
    });

    view.onShowCalled = false;

    // Another update while still open
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "second",
    });

    expect(view.onShowCalled).toBe(false);
  });

  it("does not call onHide when already closed", () => {
    // Never opened, emit close
    store.setState({
      isOpen: false,
      anchorRect: null,
      closePopup: closeFn,
      value: "closed",
    });

    expect(view.onHideCalled).toBe(false);
  });

  it("Escape key closes popup and focuses editor", () => {
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "open",
    });

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });

    document.dispatchEvent(event);

    expect(closeFn).toHaveBeenCalled();
    expect(editorView.focus).toHaveBeenCalled();
  });

  it("Escape is ignored during IME composition", () => {
    vi.mocked(isImeKeyEvent).mockReturnValue(true);

    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "open",
    });

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(event);

    expect(closeFn).not.toHaveBeenCalled();
  });

  it("click outside closes popup", () => {
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "open",
    });

    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const outsideEvent = new MouseEvent("mousedown", { bubbles: true });
        document.dispatchEvent(outsideEvent);

        expect(closeFn).toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("scroll closes popup", () => {
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "open",
    });

    // Trigger scroll on the editor container
    const editorContainer = editorView.dom.closest(".editor-container");
    if (editorContainer) {
      const scrollEvent = new Event("scroll", { bubbles: true });
      editorContainer.dispatchEvent(scrollEvent);
    }

    expect(closeFn).toHaveBeenCalled();
  });

  it("destroy removes container from DOM and unsubscribes", () => {
    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "open",
    });

    const container = view.getContainer();
    expect(container.parentElement).not.toBeNull();

    view.destroy();

    expect(container.parentElement).toBeNull();
    // After destroy, store updates should not cause errors
    store.setState({
      isOpen: false,
      anchorRect: null,
      closePopup: closeFn,
      value: "after-destroy",
    });
  });

  it("isVisible returns true when shown, false when hidden", () => {
    expect(view.testIsVisible()).toBe(false);

    store.setState({
      isOpen: true,
      anchorRect: ANCHOR,
      closePopup: closeFn,
      value: "open",
    });

    expect(view.testIsVisible()).toBe(true);

    store.setState({
      isOpen: false,
      anchorRect: null,
      closePopup: closeFn,
      value: "closed",
    });

    expect(view.testIsVisible()).toBe(false);
  });

  it("mounts on document.body with fixed positioning when the editor DOM has no host", () => {
    // A detached editor DOM has neither an .editor-container nor a parent.
    view.destroy();
    view = new TestPopupView(createEditorView(null), store);

    store.setState({ isOpen: true, anchorRect: ANCHOR, closePopup: closeFn, value: "open" });

    expect(view.getContainer().style.position).toBe("fixed");
    expect(view.getContainer().parentElement).toBe(document.body);
  });

  it("mounts inside the enclosing .editor-container with absolute positioning", () => {
    store.setState({ isOpen: true, anchorRect: ANCHOR, closePopup: closeFn, value: "open" });

    const editorContainer = editorView.dom.parentElement;
    expect(editorContainer?.classList.contains("editor-container")).toBe(true);
    expect(view.getContainer().style.position).toBe("absolute");
    expect(view.getContainer().parentElement).toBe(editorContainer);
  });

  it("falls back to the editor DOM's parent when there is no .editor-container", () => {
    const parent = document.createElement("section");
    document.body.appendChild(parent);
    view.destroy();
    view = new TestPopupView(createEditorView(parent), store);

    store.setState({ isOpen: true, anchorRect: ANCHOR, closePopup: closeFn, value: "open" });

    expect(view.getContainer().style.position).toBe("absolute");
    expect(view.getContainer().parentElement).toBe(parent);
  });
});
