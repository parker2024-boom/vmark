/**
 * Tests for createSourcePopupPlugin — branch-level cases of the click, hover
 * and update paths.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { PopupStoreBase, SourcePopupView, StoreApi } from "./SourcePopupView";

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

describe("createSourcePopupPlugin — click, hover and update branches", () => {
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

  it("update clears existing hideTimeout before setting a new one", () => {
    // First call sets a hideTimeout; second call should clear it before creating another
    mockStore.state.isOpen = true;
    const detectTrigger = vi.fn(() => null);
    const { instance, view } = instantiatePlugin({ detectTrigger });

    const mockUpdate = {
      view,
      selectionSet: true,
      docChanged: false,
      transactions: [],
    } as unknown as ViewUpdate;

    // First update — creates hideTimeout
    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);

    // Second update before the first timeout fires — should clear existing and create new
    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);

    // Only one close should happen (the second timeout fires; the first was cleared)
    vi.advanceTimersByTime(200);
    expect(mockStore.closePopup).toHaveBeenCalledTimes(1);
  });

  it("click handler returns early when pos outside detectTriggerAtPos range", () => {
    // detectTriggerAtPos returns a range that doesn't contain the click pos
    const customOpen = vi.fn();
    // posAtCoords returns 5; detectTriggerAtPos returns range [8, 15] — pos 5 < from 8
    const detectTriggerAtPos = vi.fn(() => ({ from: 8, to: 15 }));

    const { view } = instantiatePlugin({
      detectTriggerAtPos,
      openPopup: customOpen,
      triggerOnClick: true,
    });

    // posAtCoords returns 5 (default in createMockEditorView)
    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      // Should not open — pos (5) < range.from (8)
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("click handler uses store.openPopup when no custom openPopup provided", () => {
    // Omit config.openPopup — falls through to store.getState().openPopup
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));
    const extractData = vi.fn(() => ({ extra: "val" }));

    const { view } = instantiatePlugin({
      detectTriggerAtPos,
      extractData,
      triggerOnClick: true,
      // No openPopup config — will use store.getState().openPopup
    });

    // posAtCoords returns 5 which is inside [0, 10]
    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      // store.openPopup (openPopupFn) should have been called with data + anchorRect
      expect(mockStore.openPopupFn).toHaveBeenCalledWith(
        expect.objectContaining({ extra: "val" })
      );
    }
  });

  it("click handler skips open when store has no openPopup function", () => {
    // Store without openPopup — typeof openFn !== "function", so the open call is skipped
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));

    // Build a store without openPopup
    const closePopup = vi.fn();
    const stateNoOpen: PopupStoreBase = { isOpen: false, anchorRect: null, closePopup };
    const storeNoOpen: StoreApi<PopupStoreBase> = {
      getState: () => stateNoOpen,
      subscribe: vi.fn(() => () => {}),
    };

    const plugin = createSourcePopupPlugin({
      store: storeNoOpen as StoreApi<TestState>,
      createView: () => mockPopupView,
      detectTrigger: () => null,
      extractData: () => ({}) as object,
      detectTriggerAtPos,
      triggerOnClick: true,
    });
    const mockView = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = mockView;
    const createFn = (plugin as unknown as { create: (view: EditorView) => unknown }).create;
    createFn(mockView);

    const calls = (mockView.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      // Should not throw even though store has no openPopup
      expect(() => clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }))).not.toThrow();
    }
  });

  it("hover timeout: store.openPopup called when no custom openPopup", () => {
    // Omit config.openPopup in hover path — falls through to store.getState().openPopup
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));
    const extractData = vi.fn(() => ({ hoverData: true }));

    const { view } = instantiatePlugin({
      detectTriggerAtPos,
      extractData,
      triggerOnHover: true,
      hoverDelay: 100,
      // No openPopup config
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      vi.advanceTimersByTime(150);
      // store.openPopup should be called
      expect(mockStore.openPopupFn).toHaveBeenCalledWith(
        expect.objectContaining({ hoverData: true })
      );
    }
  });

  it("hover timeout: skips open when store has no openPopup function", () => {
    // Store without openPopup — typeof openFn !== "function", so the open call is skipped
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));

    const closePopup = vi.fn();
    const stateNoOpen: PopupStoreBase = { isOpen: false, anchorRect: null, closePopup };
    const storeNoOpen: StoreApi<PopupStoreBase> = {
      getState: () => stateNoOpen,
      subscribe: vi.fn(() => () => {}),
    };

    const plugin = createSourcePopupPlugin({
      store: storeNoOpen as StoreApi<TestState>,
      createView: () => mockPopupView,
      detectTrigger: () => null,
      extractData: () => ({}) as object,
      detectTriggerAtPos,
      triggerOnHover: true,
      hoverDelay: 100,
    });
    const mockView = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = mockView;
    const createFn = (plugin as unknown as { create: (view: EditorView) => unknown }).create;
    createFn(mockView);

    const calls = (mockView.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      // Should not throw even though store has no openPopup
      expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    }
  });

  it("hover timeout: isMouseDown abort guard — set isMouseDown directly before timer fires", () => {
    // Line 250: `if (this.isMouseDown) return;` inside the setTimeout callback.
    // mousedown handler calls cancelHoverTimeout so we can't use it normally.
    // Instead, directly set the private isMouseDown field on the instance to true
    // BEFORE advancing timers, so the guard fires when the hoverTimeout callback runs.
    const customOpen = vi.fn();
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));

    const { instance, view } = instantiatePlugin({
      detectTriggerAtPos,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 100,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      // Start the hover timer
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      // Set isMouseDown directly on the instance (bypassing cancelHoverTimeout)
      (instance as Record<string, unknown>)["isMouseDown"] = true;
      // Now advance timers — timer fires but isMouseDown guard returns early
      vi.advanceTimersByTime(150);
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("destroy clears active hoverTimeout", () => {
    // Start a hover timer then destroy before it fires — destroy clears hoverTimeout
    const customOpen = vi.fn();
    const detectTriggerAtPos = vi.fn(() => ({ from: 0, to: 10 }));

    const { instance, view } = instantiatePlugin({
      detectTriggerAtPos,
      openPopup: customOpen,
      triggerOnHover: true,
      hoverDelay: 500,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mousemoveHandler = calls.find((c: unknown[]) => c[0] === "mousemove")?.[1] as (e: MouseEvent) => void;

    if (mousemoveHandler) {
      // Start the hover timer (sets this.hoverTimeout)
      mousemoveHandler(new MouseEvent("mousemove", { clientX: 50, clientY: 100 }));
      // Destroy while hoverTimeout is active — destroy clears the pending hoverTimeout
      expect(() => (instance as { destroy: () => void }).destroy()).not.toThrow();
      // Advance past the hoverDelay — popup should NOT open (timer was cleared)
      vi.advanceTimersByTime(600);
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("update scrollIntoView with isOpen and anchorRect", () => {
    // Need scrollIntoView transaction with popup open and anchorRect set
    mockStore.state.isOpen = true;
    mockStore.state.anchorRect = { top: 100, left: 50, bottom: 120, right: 200 };

    const { instance, view } = instantiatePlugin();

    const mockUpdate = {
      view,
      selectionSet: false,
      docChanged: false,
      transactions: [{ scrollIntoView: true }],
    } as unknown as ViewUpdate;

    // Should not throw — enters the if (state.isOpen && state.anchorRect) branch
    expect(() => (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate)).not.toThrow();
  });

  it("update scrollIntoView with popup closed skips anchorRect check", () => {
    mockStore.state.isOpen = false;
    mockStore.state.anchorRect = null;

    const { instance, view } = instantiatePlugin();

    const mockUpdate = {
      view,
      selectionSet: false,
      docChanged: false,
      transactions: [{ scrollIntoView: true }],
    } as unknown as ViewUpdate;

    expect(() => (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate)).not.toThrow();
  });

  it("hideTimeout callback skips close when popup is no longer open", () => {
    // Set isOpen=true initially, trigger the hideTimeout, then set isOpen=false before timer fires
    mockStore.state.isOpen = true;
    const detectTrigger = vi.fn(() => null);
    const { instance, view } = instantiatePlugin({ detectTrigger });

    const mockUpdate = {
      view,
      selectionSet: true,
      docChanged: false,
      transactions: [],
    } as unknown as ViewUpdate;

    // Trigger hideTimeout creation
    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);

    // Popup closes externally before the timeout fires
    mockStore.state.isOpen = false;

    // Advance timer — callback fires but isOpen is false, so closePopup NOT called
    vi.advanceTimersByTime(200);
    expect(mockStore.closePopup).not.toHaveBeenCalled();
  });

  it("destroy with triggerOnClick false skips the click comment block", () => {
    const { instance } = instantiatePlugin({ triggerOnClick: false });
    // destroy() with triggerOnClick=false skips the if (triggerOnClick) branch
    expect(() => (instance as { destroy: () => void }).destroy()).not.toThrow();
    expect(mockPopupView.destroy).toHaveBeenCalled();
  });

  it("destroy clears active hideTimeout", () => {
    // Start a hide timer via mouseleave then destroy before it fires — destroy clears hideTimeout
    mockStore.state.isOpen = true;

    const { instance, view } = instantiatePlugin({
      triggerOnHover: true,
      hoverHideDelay: 500,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const mouseleaveHandler = calls.find((c: unknown[]) => c[0] === "mouseleave")?.[1] as () => void;

    if (mouseleaveHandler) {
      // Start the hide timer (sets this.hideTimeout)
      mouseleaveHandler();
      // Destroy while hideTimeout is active — destroy clears the pending hideTimeout
      expect(() => (instance as { destroy: () => void }).destroy()).not.toThrow();
      // Advance past the hideDelay — popup should NOT close (timer was cleared)
      vi.advanceTimersByTime(600);
      expect(mockStore.closePopup).not.toHaveBeenCalled();
    }
  });
});
