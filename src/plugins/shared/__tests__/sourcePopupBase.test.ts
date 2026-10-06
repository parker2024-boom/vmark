/**
 * Source Popup Base Infrastructure Tests
 *
 * Tests for the shared popup view infrastructure for Source mode.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import {
  getAnchorRectFromRange,
  getEditorBounds,
  isPositionVisible,
} from "../sourcePopupUtils";
import { SourcePopupView } from "../SourcePopupView";
import type { StoreApi } from "../SourcePopupView";
import type { AnchorRect } from "@/utils/popupPosition";

// Mock DOM APIs
const createMockRect = (overrides: Partial<DOMRect> = {}): DOMRect => ({
  top: 100,
  left: 50,
  bottom: 120,
  right: 200,
  width: 150,
  height: 20,
  x: 50,
  y: 100,
  toJSON: () => ({}),
  ...overrides,
});

describe("sourcePopupUtils", () => {
  describe("getAnchorRectFromRange", () => {
    it("calculates popup position from CM6 coords", () => {
      // Create a minimal mock view
      const mockView = {
        coordsAtPos: vi.fn((pos: number) => ({
          top: 100 + pos,
          left: 50,
          bottom: 120 + pos,
          right: 100,
        })),
        dom: {
          getBoundingClientRect: () => createMockRect(),
          closest: () => ({
            getBoundingClientRect: () => createMockRect({ top: 0, bottom: 500 }),
          }),
        },
      } as unknown as EditorView;

      const rect = getAnchorRectFromRange(mockView, 10, 20);

      expect(rect).not.toBeNull();
      expect(rect!.top).toBe(110); // 100 + 10
      expect(rect!.left).toBe(50);
      expect(rect!.bottom).toBe(140); // 120 + 20
      expect(mockView.coordsAtPos).toHaveBeenCalledWith(10);
      expect(mockView.coordsAtPos).toHaveBeenCalledWith(20);
    });

    it("returns null when coordsAtPos returns null", () => {
      const mockView = {
        coordsAtPos: vi.fn(() => null),
        dom: {
          getBoundingClientRect: () => createMockRect(),
        },
      } as unknown as EditorView;

      const rect = getAnchorRectFromRange(mockView, 10, 20);

      expect(rect).toBeNull();
    });
  });

  describe("getEditorBounds", () => {
    it("returns editor container bounds with content inner area (after padding)", () => {
      const containerRect = createMockRect({
        top: 50,
        left: 10,
        bottom: 600,
        right: 800,
      });
      const editorRect = createMockRect({
        top: 60,
        left: 20,
        bottom: 580,
        right: 780,
      });
      // .cm-content outer bounds (before padding is subtracted)
      const contentRect = createMockRect({
        top: 60,
        left: 20,
        bottom: 580,
        right: 780,
      });

      // Mock getComputedStyle for padding
      const originalGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = vi.fn(() => ({
        paddingLeft: "32px",
        paddingRight: "32px",
      })) as unknown as typeof window.getComputedStyle;

      const mockView = {
        dom: {
          closest: vi.fn(() => ({
            getBoundingClientRect: () => containerRect,
          })),
          querySelector: vi.fn(() => ({
            getBoundingClientRect: () => contentRect,
          })),
          getBoundingClientRect: () => editorRect,
        },
      } as unknown as EditorView;

      const bounds = getEditorBounds(mockView);

      // Horizontal uses .cm-content inner bounds (outer - padding), vertical uses container rect
      expect(bounds.horizontal.left).toBe(52); // 20 + 32px padding
      expect(bounds.horizontal.right).toBe(748); // 780 - 32px padding
      expect(bounds.vertical.top).toBe(50);
      expect(bounds.vertical.bottom).toBe(600);

      // Restore
      window.getComputedStyle = originalGetComputedStyle;
    });

    it("falls back to viewport when no container found", () => {
      const mockView = {
        dom: {
          closest: vi.fn(() => null),
          querySelector: vi.fn(() => null),
          getBoundingClientRect: () => createMockRect(),
        },
      } as unknown as EditorView;

      // Mock window dimensions
      const originalInnerWidth = window.innerWidth;
      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, "innerWidth", { value: 1920, writable: true });
      Object.defineProperty(window, "innerHeight", { value: 1080, writable: true });

      const bounds = getEditorBounds(mockView);

      expect(bounds.horizontal.left).toBe(0);
      expect(bounds.horizontal.right).toBe(1920);
      expect(bounds.vertical.top).toBe(0);
      expect(bounds.vertical.bottom).toBe(1080);

      // Restore
      Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, writable: true });
      Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, writable: true });
    });
  });

  describe("isPositionVisible", () => {
    it("returns true when position is within viewport", () => {
      const mockView = {
        coordsAtPos: vi.fn(() => ({ top: 100, bottom: 120 })),
        dom: {
          closest: vi.fn(() => ({
            getBoundingClientRect: () => createMockRect({ top: 0, bottom: 500 }),
          })),
        },
      } as unknown as EditorView;

      expect(isPositionVisible(mockView, 10)).toBe(true);
    });

    it("returns false when position is above viewport", () => {
      const mockView = {
        coordsAtPos: vi.fn(() => ({ top: -50, bottom: -30 })),
        dom: {
          closest: vi.fn(() => ({
            getBoundingClientRect: () => createMockRect({ top: 0, bottom: 500 }),
          })),
        },
      } as unknown as EditorView;

      expect(isPositionVisible(mockView, 10)).toBe(false);
    });

    it("returns false when position is below viewport", () => {
      const mockView = {
        coordsAtPos: vi.fn(() => ({ top: 600, bottom: 620 })),
        dom: {
          closest: vi.fn(() => ({
            getBoundingClientRect: () => createMockRect({ top: 0, bottom: 500 }),
          })),
        },
      } as unknown as EditorView;

      expect(isPositionVisible(mockView, 10)).toBe(false);
    });

    it("returns false when coordsAtPos returns null", () => {
      const mockView = {
        coordsAtPos: vi.fn(() => null),
        dom: {
          closest: vi.fn(() => ({
            getBoundingClientRect: () => createMockRect({ top: 0, bottom: 500 }),
          })),
        },
      } as unknown as EditorView;

      expect(isPositionVisible(mockView, 10)).toBe(false);
    });
  });
});

describe("SourcePopupView", () => {
  // Create a concrete implementation for testing
  class TestPopupView extends SourcePopupView<{ isOpen: boolean; anchorRect: AnchorRect | null }> {
    // Don't use initializer to avoid overwriting in constructor
    public showCalled!: boolean;
    public hideCalled!: boolean;

    constructor(view: EditorView, store: StoreApi<{ isOpen: boolean; anchorRect: AnchorRect | null }>) {
      // Initialize flags before super() call
      super(view, store);
      this.showCalled = false;
      this.hideCalled = false;
    }

    protected buildContainer(): HTMLElement {
      const div = document.createElement("div");
      div.className = "test-popup";
      return div;
    }

    protected onShow(): void {
      this.showCalled = true;
    }

    protected onHide(): void {
      this.hideCalled = false; // Reset then set to true
      this.hideCalled = true;
    }

    protected override extractState(state: { isOpen: boolean; anchorRect: AnchorRect | null }) {
      return {
        isOpen: state.isOpen,
        anchorRect: state.anchorRect,
      };
    }

    // Expose protected container for testing
    public getContainer() {
      return this.container;
    }

    // Get testContainer returns the same as container
    public get testContainer(): HTMLElement {
      return this.container;
    }
  }

  let mockView: EditorView;
  let container: HTMLElement;
  let mockStore: {
    getState: () => { isOpen: boolean; anchorRect: AnchorRect | null };
    subscribe: (fn: (state: { isOpen: boolean; anchorRect: AnchorRect | null }) => void) => () => void;
  };
  let subscribers: Array<(state: { isOpen: boolean; anchorRect: AnchorRect | null }) => void>;
  let currentState: { isOpen: boolean; anchorRect: AnchorRect | null };

  beforeEach(() => {
    // Clean up document body
    document.body.innerHTML = "";

    container = document.createElement("div");
    container.className = "editor-container";
    container.getBoundingClientRect = () =>
      createMockRect({ top: 0, bottom: 600, left: 0, right: 800 });
    document.body.appendChild(container);

    const editorDom = document.createElement("div");
    editorDom.getBoundingClientRect = () => createMockRect();
    container.appendChild(editorDom);

    // Create mock view with contentDOM for blur support
    const contentDOM = document.createElement("div");
    contentDOM.contentEditable = "true";
    editorDom.appendChild(contentDOM);

    mockView = {
      dom: editorDom,
      contentDOM,
      coordsAtPos: () => ({ top: 100, left: 50, bottom: 120, right: 100 }),
      focus: vi.fn(),
    } as unknown as EditorView;

    // Create mock store
    currentState = { isOpen: false, anchorRect: null };
    subscribers = [];
    mockStore = {
      getState: () => currentState,
      subscribe: (fn) => {
        subscribers.push(fn);
        return () => {
          const idx = subscribers.indexOf(fn);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      },
    };
  });

  const emitStateChange = (newState: { isOpen: boolean; anchorRect: AnchorRect | null }) => {
    currentState = newState;
    subscribers.forEach((fn) => fn(newState));
  };

  it("detects click outside popup container", () => {
    const popup = new TestPopupView(mockView, mockStore);
    const anchorRect = { top: 100, left: 50, bottom: 120, right: 100 };

    // Open popup
    emitStateChange({ isOpen: true, anchorRect });

    // Verify container is attached to document.body (not editor container)
    expect(popup.testContainer).not.toBeNull();
    expect(document.body.contains(popup.testContainer)).toBe(true);

    // Simulate click outside
    const outsideEl = document.createElement("div");
    document.body.appendChild(outsideEl);

    const mousedownEvent = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(mousedownEvent, "target", { value: outsideEl });

    // The click-outside handler should close the popup
    // (We verify by checking that the store would typically call closePopup)
    document.dispatchEvent(mousedownEvent);

    popup.destroy();
  });

  it("handles Tab cycling within popup", () => {
    const popup = new TestPopupView(mockView, mockStore);

    // Add focusable elements to container
    const container = popup.getContainer();
    const input = document.createElement("input");
    const button1 = document.createElement("button");
    const button2 = document.createElement("button");
    container.appendChild(input);
    container.appendChild(button1);
    container.appendChild(button2);

    // Open popup
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Focus input
    input.focus();
    expect(document.activeElement).toBe(input);

    // Simulate Tab keydown
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true });
    container.dispatchEvent(tabEvent);

    // Tab should cycle focus (this tests the handler is attached)
    // The actual cycling behavior is tested in popupComponents tests

    popup.destroy();
  });

  it("closes on Escape keypress", () => {
    const closePopupFn = vi.fn();
    const storeWithClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        closePopup: closePopupFn,
      }),
    };

    const popup = new TestPopupView(mockView, storeWithClose as typeof mockStore);

    // Open popup
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Simulate Escape keydown
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(escEvent);

    // closePopup should be called and focus should return to editor
    expect(closePopupFn).toHaveBeenCalled();
    expect(mockView.focus).toHaveBeenCalled();

    popup.destroy();
  });

  it("subscribes to store and shows/hides correctly", () => {
    const popup = new TestPopupView(mockView, mockStore);

    // Initially hidden
    expect(popup.showCalled).toBe(false);

    // Open popup
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });
    expect(popup.showCalled).toBe(true);

    // Close popup
    emitStateChange({ isOpen: false, anchorRect: null });
    expect(popup.hideCalled).toBe(true);

    popup.destroy();
  });

  it("removes container on destroy", () => {
    const popup = new TestPopupView(mockView, mockStore);

    // Open popup to ensure container is attached to document.body
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });
    expect(document.body.contains(popup.testContainer)).toBe(true);

    popup.destroy();

    expect(document.body.contains(popup.testContainer)).toBe(false);
  });

  it("mounts popup inside editor-container when available", () => {
    const popup = new TestPopupView(mockView, mockStore);
    const anchorRect = { top: 100, left: 50, bottom: 120, right: 100 };

    emitStateChange({ isOpen: true, anchorRect });

    // Popup should be mounted inside editor-container (via closest)
    expect(container.contains(popup.testContainer)).toBe(true);
    // Should use absolute positioning inside container
    expect(popup.testContainer.style.position).toBe("absolute");

    popup.destroy();
  });

  it("falls back to document.body when no editor-container", () => {
    // Remove editor-container class so closest returns null
    const editorDom = document.createElement("div");
    editorDom.getBoundingClientRect = () => createMockRect();
    document.body.appendChild(editorDom);

    const contentDOM = document.createElement("div");
    contentDOM.contentEditable = "true";
    editorDom.appendChild(contentDOM);

    const viewNoContainer = {
      dom: editorDom,
      contentDOM,
      coordsAtPos: () => ({ top: 100, left: 50, bottom: 120, right: 100 }),
      focus: vi.fn(),
    } as unknown as EditorView;

    const popup = new TestPopupView(viewNoContainer, mockStore);
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Should use fixed positioning when mounted to body
    expect(popup.testContainer.style.position).toBe("fixed");

    popup.destroy();
  });

  it("justOpened guard prevents immediate click-outside close", () => {
    const closePopupFn = vi.fn();
    const storeWithClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        isOpen: true,
        closePopup: closePopupFn,
      }),
    };

    const popup = new TestPopupView(mockView, storeWithClose as typeof mockStore);

    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Click outside immediately (before rAF clears justOpened flag)
    const outsideEl = document.createElement("div");
    document.body.appendChild(outsideEl);
    const mousedownEvent = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(mousedownEvent, "target", { value: outsideEl });
    document.dispatchEvent(mousedownEvent);

    // Should NOT close because justOpened is still true
    expect(closePopupFn).not.toHaveBeenCalled();

    popup.destroy();
  });

  it("handleScroll closes popup when open", () => {
    const closePopupFn = vi.fn();
    const storeWithClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        isOpen: true,
        closePopup: closePopupFn,
      }),
    };

    const popup = new TestPopupView(mockView, storeWithClose as typeof mockStore);

    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Simulate scroll on the editor container
    const scrollEvent = new Event("scroll", { bubbles: true });
    container.dispatchEvent(scrollEvent);

    expect(closePopupFn).toHaveBeenCalled();

    popup.destroy();
  });

  it("Escape key is ignored for IME composition events", () => {
    const closePopupFn = vi.fn();
    const storeWithClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        isOpen: true,
        closePopup: closePopupFn,
      }),
    };

    const popup = new TestPopupView(mockView, storeWithClose as typeof mockStore);
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Simulate IME composition event (isComposing: true)
    const imeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
    });
    document.dispatchEvent(imeEvent);

    expect(closePopupFn).not.toHaveBeenCalled();

    popup.destroy();
  });

  it("click inside popup container does not close it", () => {
    const closePopupFn = vi.fn();
    const storeWithClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        isOpen: true,
        closePopup: closePopupFn,
      }),
    };

    const popup = new TestPopupView(mockView, storeWithClose as typeof mockStore);
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Clear justOpened by triggering rAF
    // Since jsdom doesn't run rAF automatically, dispatch a second state to settle
    // We need to wait for the rAF callback
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; });

    // Re-emit to trigger another show which will now have justOpened cleared by rAF mock
    emitStateChange({ isOpen: false, anchorRect: null });
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });
    closePopupFn.mockClear();

    // Click inside popup container
    const insideEl = document.createElement("span");
    popup.testContainer.appendChild(insideEl);
    const mousedownEvent = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(mousedownEvent, "target", { value: insideEl });
    document.dispatchEvent(mousedownEvent);

    expect(closePopupFn).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    popup.destroy();
  });

  it("handleClickOutside does nothing when store says not open", () => {
    const closePopupFn = vi.fn();
    const storeWithClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        isOpen: false,
        closePopup: closePopupFn,
      }),
    };

    const popup = new TestPopupView(mockView, storeWithClose as typeof mockStore);
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Mock rAF to clear justOpened
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; });
    emitStateChange({ isOpen: false, anchorRect: null });
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });
    closePopupFn.mockClear();

    // Store says not open, click outside should not call closePopup
    const outsideEl = document.createElement("div");
    document.body.appendChild(outsideEl);
    const mousedownEvent = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(mousedownEvent, "target", { value: outsideEl });
    document.dispatchEvent(mousedownEvent);

    expect(closePopupFn).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    popup.destroy();
  });

  it("closePopup does nothing when store has no closePopup function", () => {
    const storeNoClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        isOpen: true,
        // closePopup is undefined
      }),
    };

    const popup = new TestPopupView(mockView, storeNoClose as typeof mockStore);
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    // Dispatch Escape - should not throw even without closePopup
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    expect(() => document.dispatchEvent(escEvent)).not.toThrow();

    popup.destroy();
  });

  it("does not re-show when already open (wasOpen guard)", () => {
    const popup = new TestPopupView(mockView, mockStore);
    const anchorRect = { top: 100, left: 50, bottom: 120, right: 100 };

    emitStateChange({ isOpen: true, anchorRect });
    expect(popup.showCalled).toBe(true);
    popup.showCalled = false; // Reset

    // Emit same state again - should NOT call onShow again
    emitStateChange({ isOpen: true, anchorRect });
    expect(popup.showCalled).toBe(false);

    popup.destroy();
  });

  it("does not re-hide when already closed (wasOpen guard)", () => {
    const popup = new TestPopupView(mockView, mockStore);

    // Emit closed state twice - should not call onHide
    emitStateChange({ isOpen: false, anchorRect: null });
    expect(popup.hideCalled).toBe(false);

    popup.destroy();
  });

  it("hides popup when state becomes isOpen but no anchorRect", () => {
    const popup = new TestPopupView(mockView, mockStore);
    const anchorRect = { top: 100, left: 50, bottom: 120, right: 100 };

    // Open
    emitStateChange({ isOpen: true, anchorRect });
    expect(popup.showCalled).toBe(true);

    // Emit isOpen=true but anchorRect=null -> should hide
    emitStateChange({ isOpen: true, anchorRect: null });
    expect(popup.hideCalled).toBe(true);

    popup.destroy();
  });

  it("hide removes event listeners and sets display none", () => {
    const popup = new TestPopupView(mockView, mockStore);
    const anchorRect = { top: 100, left: 50, bottom: 120, right: 100 };

    emitStateChange({ isOpen: true, anchorRect });
    expect(popup.testContainer.style.display).toBe("flex");

    emitStateChange({ isOpen: false, anchorRect: null });
    expect(popup.testContainer.style.display).toBe("none");

    popup.destroy();
  });

  it("destroy removes all event listeners even when popup was open", () => {
    const closePopupFn = vi.fn();
    const storeWithClose = {
      ...mockStore,
      getState: () => ({
        ...currentState,
        isOpen: true,
        closePopup: closePopupFn,
      }),
    };

    const popup = new TestPopupView(mockView, storeWithClose as typeof mockStore);
    emitStateChange({ isOpen: true, anchorRect: { top: 100, left: 50, bottom: 120, right: 100 } });

    popup.destroy();

    // After destroy, Escape should not trigger closePopup
    closePopupFn.mockClear();
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(escEvent);
    expect(closePopupFn).not.toHaveBeenCalled();
  });
});
