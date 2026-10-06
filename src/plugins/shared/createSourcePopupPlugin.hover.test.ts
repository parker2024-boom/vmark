/**
 * Tests for createSourcePopupPlugin — hover-trigger logic.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { SourcePopupView } from "./SourcePopupView";

import {
  createSourcePopupPlugin,
  type PopupTriggerConfig,
} from "./createSourcePopupPlugin";
import {
  type TestState,
  createMockStore,
  createMockPopupView,
  createMockEditorView,
} from "./__tests__/sourcePopupPluginHarness";

describe("createSourcePopupPlugin — hover handler logic", () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockPopupView: SourcePopupView<TestState>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStore = createMockStore();
    mockPopupView = createMockPopupView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["container"] = document.createElement("div");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function instantiatePlugin(config: Partial<PopupTriggerConfig<TestState>> = {}) {
    const plugin = createSourcePopupPlugin({
      store: mockStore.store,
      createView: () => mockPopupView,
      detectTrigger: () => null,
      extractData: () => ({}) as object,
      ...config,
    });
    const mockView = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = mockView;
    const createFn = (plugin as unknown as { create: (view: EditorView) => unknown }).create;
    const instance = createFn(mockView);
    return { instance: instance as Record<string, unknown>, view: mockView };
  }

  it("mousemove triggers popup after hover delay", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 200,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));

      // Before delay: popup not opened
      expect(customOpen).not.toHaveBeenCalled();

      // After delay: popup should open
      vi.advanceTimersByTime(250);
      expect(customOpen).toHaveBeenCalled();
    }
  });

  it("mouseleave cancels hover and starts hide timer", () => {
    mockStore.state.isOpen = true;
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      triggerOnHover: true,
      hoverHideDelay: 100,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mouseleaveHandler = calls.find((c: unknown[]) => c[0] === "mouseleave")?.[1] as () => void;

    if (mouseleaveHandler) {
      mouseleaveHandler();

      // After hide delay, popup should close
      vi.advanceTimersByTime(150);
      expect(mockStore.closePopup).toHaveBeenCalled();
    }
  });

  it("mousedown cancels hover timeout", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 200,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;
    const mousedownHandler = calls.find((c: unknown[]) => c[0] === "mousedown")?.[1] as () => void;

    if (mousemoveHandler && mousedownHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      mousedownHandler();

      vi.advanceTimersByTime(300);
      // Should NOT open because mousedown cancelled the timer
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("same hover range does not restart timer", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 200,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      // First move
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(100);

      // Second move to same range — should not restart timer
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 55, clientY: 105 }));
      vi.advanceTimersByTime(100);

      // Total 200ms from first move — should trigger
      expect(customOpen).toHaveBeenCalledTimes(1);
    }
  });

  it("mousemove with null pos cancels hover", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 200,
    });

    (view.posAtCoords as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(300);
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("mouseup resets isMouseDown so hover works again", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 200,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousedownHandler = calls.find((c: unknown[]) => c[0] === "mousedown")?.[1] as () => void;
    const mouseupHandler = calls.find((c: unknown[]) => c[0] === "mouseup")?.[1] as () => void;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousedownHandler && mouseupHandler && mousemoveHandler) {
      mousedownHandler();
      mouseupHandler();

      // Hover should work again after mouseup
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(250);
      expect(customOpen).toHaveBeenCalled();
    }
  });
});

describe("createSourcePopupPlugin — hover with detectTriggerAtPos", () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockPopupView: SourcePopupView<TestState>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStore = createMockStore();
    mockPopupView = createMockPopupView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["container"] = document.createElement("div");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function instantiatePlugin(config: Partial<PopupTriggerConfig<TestState>> = {}) {
    const plugin = createSourcePopupPlugin({
      store: mockStore.store,
      createView: () => mockPopupView,
      detectTrigger: () => null,
      extractData: () => ({}) as object,
      ...config,
    });
    const mockView = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = mockView;
    const createFn = (plugin as unknown as { create: (view: EditorView) => unknown }).create;
    const instance = createFn(mockView);
    return { instance: instance as Record<string, unknown>, view: mockView };
  }

  it("hover uses detectTriggerAtPos when provided", () => {
    const detectTriggerAtPos = vi.fn(() => ({ from: 3, to: 8 }));
    const customOpen = vi.fn();

    const { view } = instantiatePlugin({
      detectTriggerAtPos,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 100,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(150);
      expect(detectTriggerAtPos).toHaveBeenCalled();
      expect(customOpen).toHaveBeenCalled();
    }
  });

  it("hover falls back to detectTrigger when detectTriggerAtPos not provided and pos outside range", () => {
    const detectTrigger = vi.fn(() => ({ from: 10, to: 20 }));
    const customOpen = vi.fn();

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 100,
    });

    // posAtCoords returns 5, which is outside the detected range 10-20
    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(150);
      // Range should not match since pos (5) is outside [10,20]
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("mousemove cancels on isMouseDown", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 100,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousedownHandler = calls.find((c: unknown[]) => c[0] === "mousedown")?.[1] as () => void;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousedownHandler && mousemoveHandler) {
      mousedownHandler(); // Set isMouseDown
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(300);
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("mousemove no-trigger clears lastHoverRange", () => {
    const customOpen = vi.fn();
    let callCount = 0;
    const detectTrigger = vi.fn(() => {
      callCount++;
      if (callCount <= 1) return { from: 0, to: 10 };
      return null;
    });

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 200,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(50);
      // Move to no-trigger area
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 60, clientY: 110 }));
      vi.advanceTimersByTime(300);
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("hover uses store openPopup when no custom openPopup and uses onOpen", () => {
    const onOpen = vi.fn();
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTriggerAtPos,
      onOpen,
      triggerOnHover: true,
      hoverDelay: 100,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(150);
      expect(onOpen).toHaveBeenCalled();
      expect(mockStore.openPopupFn).toHaveBeenCalled();
    }
  });

  it("mouseleave does not start hide timer when popup is not open", () => {
    mockStore.state.isOpen = false;

    const { view } = instantiatePlugin({
      triggerOnHover: true,
      hoverHideDelay: 100,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mouseleaveHandler = calls.find((c: unknown[]) => c[0] === "mouseleave")?.[1] as () => void;

    if (mouseleaveHandler) {
      mouseleaveHandler();
      vi.advanceTimersByTime(200);
      expect(mockStore.closePopup).not.toHaveBeenCalled();
    }
  });

  it("hover timer aborted when isMouseDown is set during delay", () => {
    const customOpen = vi.fn();
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTriggerAtPos,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 200,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;
    const mousedownHandler = calls.find((c: unknown[]) => c[0] === "mousedown")?.[1] as () => void;

    if (mousemoveHandler && mousedownHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(100);
      // mousedown during hover delay
      mousedownHandler();
      vi.advanceTimersByTime(200);
      // The timeout fires but isMouseDown is true, so it should not open
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("update handles scrollIntoView transaction", () => {
    mockStore.state.isOpen = true;
    mockStore.state.anchorRect = { top: 100, left: 50, bottom: 120, right: 200 };
    const { instance, view } = instantiatePlugin();

    const mockUpdate = {
      view,
      selectionSet: false,
      docChanged: false,
      transactions: [{ scrollIntoView: true }],
    } as unknown as ViewUpdate;

    // Should not throw
    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);
  });

  it("hover over a range with no screen coordinates cancels open", () => {
    const customOpen = vi.fn();
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTriggerAtPos,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 100,
    });

    // The view cannot place the range (e.g. scrolled out of layout)
    vi.mocked(view.coordsAtPos).mockReturnValue(null);

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(150);
      expect(customOpen).not.toHaveBeenCalled();
    }
  });
});

describe("createSourcePopupPlugin — cancelHoverTimeout with hideTimeout", () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockPopupView: SourcePopupView<TestState>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStore = createMockStore();
    mockPopupView = createMockPopupView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["container"] = document.createElement("div");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function instantiatePlugin(config: Partial<PopupTriggerConfig<TestState>> = {}) {
    const plugin = createSourcePopupPlugin({
      store: mockStore.store,
      createView: () => mockPopupView,
      detectTrigger: () => null,
      extractData: () => ({}) as object,
      ...config,
    });
    const mockView = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = mockView;
    const createFn = (plugin as unknown as { create: (view: EditorView) => unknown }).create;
    const instance = createFn(mockView);
    return { instance: instance as Record<string, unknown>, view: mockView };
  }

  it("mousedown cancels hideTimeout set by mouseleave", () => {
    mockStore.state.isOpen = true;

    const { view } = instantiatePlugin({
      triggerOnHover: true,
      hoverHideDelay: 200,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mouseleaveHandler = calls.find((c: unknown[]) => c[0] === "mouseleave")?.[1] as () => void;
    const mousedownHandler = calls.find((c: unknown[]) => c[0] === "mousedown")?.[1] as () => void;

    if (mouseleaveHandler && mousedownHandler) {
      // mouseleave sets hideTimeout
      mouseleaveHandler();
      // mousedown calls cancelHoverTimeout which clears hideTimeout
      mousedownHandler();
      // Advance past hideDelay — should NOT close because hideTimeout was cancelled
      vi.advanceTimersByTime(300);
      expect(mockStore.closePopup).not.toHaveBeenCalled();
    }
  });

  it("mouseleave hide timer skips close when popup is hovered", () => {
    mockStore.state.isOpen = true;
    const popupContainer = document.createElement("div");
    // Mock matches to return true (popup is hovered)
    vi.spyOn(popupContainer, "matches").mockReturnValue(true);
    (mockPopupView as unknown as Record<string, unknown>)["container"] = popupContainer;

    const { view } = instantiatePlugin({
      triggerOnHover: true,
      hoverHideDelay: 100,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mouseleaveHandler = calls.find((c: unknown[]) => c[0] === "mouseleave")?.[1] as () => void;

    if (mouseleaveHandler) {
      mouseleaveHandler();
      vi.advanceTimersByTime(150);
      // Should NOT close because popup container matches :hover
      expect(mockStore.closePopup).not.toHaveBeenCalled();
    }
  });
});
