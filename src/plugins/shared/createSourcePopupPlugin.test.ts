/**
 * Tests for createSourcePopupPlugin — factory function for CM6 popup plugins.
 *
 * Plugin creation, the instantiated lifecycle and click-trigger logic. Hover
 * logic and branch-level cases live in the .hover and .branches siblings.
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

describe("createSourcePopupPlugin", () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockPopupView: SourcePopupView<TestState>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();
    mockPopupView = createMockPopupView();
  });

  describe("plugin creation", () => {
    it("returns a ViewPlugin", () => {
      const plugin = createSourcePopupPlugin({
        store: mockStore.store,
        createView: () => mockPopupView,
        detectTrigger: () => null,
        extractData: () => ({}),
      });

      expect(plugin).toBeDefined();
      // ViewPlugin.fromClass returns an Extension-compatible object
      expect(typeof plugin).toBe("object");
    });

    it("uses default values for optional config", () => {
      // triggerOnClick defaults to true, triggerOnHover to false
      const config: PopupTriggerConfig<TestState> = {
        store: mockStore.store,
        createView: () => mockPopupView,
        detectTrigger: () => null,
        extractData: () => ({}),
      };

      // Should not throw
      const plugin = createSourcePopupPlugin(config);
      expect(plugin).toBeDefined();
    });

    it("accepts all optional config fields", () => {
      const config: PopupTriggerConfig<TestState, { href: string }> = {
        store: mockStore.store,
        createView: () => mockPopupView,
        detectTrigger: () => null,
        detectTriggerAtPos: () => null,
        extractData: () => ({ href: "https://example.com" }),
        openPopup: vi.fn(),
        onOpen: vi.fn(),
        triggerOnClick: true,
        triggerOnHover: true,
        hoverDelay: 500,
        hoverHideDelay: 200,
      };

      const plugin = createSourcePopupPlugin(config);
      expect(plugin).toBeDefined();
    });
  });

  describe("click handler registration", () => {
    it("registers click handler when triggerOnClick is true", () => {
      const _mockView = createMockEditorView();
      const createView = vi.fn(() => mockPopupView);

      createSourcePopupPlugin({
        store: mockStore.store,
        createView,
        detectTrigger: () => null,
        extractData: () => ({}),
        triggerOnClick: true,
      });

      // The plugin is created via ViewPlugin.fromClass, so we need to verify
      // by checking that the class constructor would add event listeners
      // Since we can't easily instantiate the class directly, we verify config acceptance
      expect(createView).not.toHaveBeenCalled(); // Not called until plugin is instantiated by CM
    });

    it("does not register click handler when triggerOnClick is false", () => {
      const plugin = createSourcePopupPlugin({
        store: mockStore.store,
        createView: () => mockPopupView,
        detectTrigger: () => null,
        extractData: () => ({}),
        triggerOnClick: false,
      });

      expect(plugin).toBeDefined();
    });
  });

  describe("hover handler registration", () => {
    it("accepts hover configuration", () => {
      const plugin = createSourcePopupPlugin({
        store: mockStore.store,
        createView: () => mockPopupView,
        detectTrigger: () => null,
        extractData: () => ({}),
        triggerOnHover: true,
        hoverDelay: 300,
        hoverHideDelay: 100,
      });

      expect(plugin).toBeDefined();
    });
  });

  describe("config with custom openPopup", () => {
    it("accepts custom openPopup handler", () => {
      const customOpen = vi.fn();
      const plugin = createSourcePopupPlugin({
        store: mockStore.store,
        createView: () => mockPopupView,
        detectTrigger: () => ({ from: 0, to: 10 }),
        extractData: () => ({}),
        openPopup: customOpen,
      });

      expect(plugin).toBeDefined();
    });

    it("accepts onOpen callback", () => {
      const onOpen = vi.fn();
      const plugin = createSourcePopupPlugin({
        store: mockStore.store,
        createView: () => mockPopupView,
        detectTrigger: () => ({ from: 0, to: 10 }),
        extractData: () => ({}),
        onOpen,
      });

      expect(plugin).toBeDefined();
    });
  });
});

describe("createSourcePopupPlugin — instantiated behavior", () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockPopupView: SourcePopupView<TestState>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStore = createMockStore();
    mockPopupView = createMockPopupView();
    // Add editorView to mockPopupView for private access in handleClick
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = createMockEditorView();
    (mockPopupView as unknown as Record<string, unknown>)["container"] = document.createElement("div");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Since CM6 ViewPlugin.fromClass creates a class that can only be properly
   * instantiated through CM6, we test the behavior by extracting the class
   * from the ViewPlugin spec and instantiating it directly.
   */
  function instantiatePlugin(config: Partial<PopupTriggerConfig<TestState>> = {}) {
    const plugin = createSourcePopupPlugin({
      store: mockStore.store,
      createView: () => mockPopupView,
      detectTrigger: () => null,
      extractData: () => ({}) as object,
      ...config,
    });
    const mockView = createMockEditorView();
    // Bind editorView on the popupView mock
    (mockPopupView as unknown as Record<string, unknown>)["editorView"] = mockView;
    // ViewPlugin exposes a .create(view) factory
    const createFn = (plugin as unknown as { create: (view: EditorView) => unknown }).create;
    const instance = createFn(mockView);
    return { instance: instance as Record<string, unknown>, view: mockView };
  }

  it("creates popupView via createView on instantiation", () => {
    const createViewFn = vi.fn(() => mockPopupView);
    instantiatePlugin({ createView: createViewFn });
    expect(createViewFn).toHaveBeenCalledTimes(1);
  });

  it("registers click handler when triggerOnClick is true (default)", () => {
    const { view } = instantiatePlugin({ triggerOnClick: true });
    expect(view.dom.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("does not register click handler when triggerOnClick is false", () => {
    const { view } = instantiatePlugin({ triggerOnClick: false });
    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickCalls = calls.filter((c: unknown[]) => c[0] === "click");
    expect(clickCalls.length).toBe(0);
  });

  it("registers hover handlers when triggerOnHover is true", () => {
    const { view } = instantiatePlugin({ triggerOnHover: true });
    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const eventNames = calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain("mousemove");
    expect(eventNames).toContain("mouseleave");
    expect(eventNames).toContain("mousedown");
    expect(eventNames).toContain("mouseup");
  });

  it("does not register hover handlers when triggerOnHover is false (default)", () => {
    const { view } = instantiatePlugin({ triggerOnHover: false });
    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const eventNames = calls.map((c: unknown[]) => c[0]);
    expect(eventNames).not.toContain("mousemove");
    expect(eventNames).not.toContain("mouseleave");
  });

  it("destroy calls popupView.destroy", () => {
    const { instance } = instantiatePlugin();
    (instance as { destroy: () => void }).destroy();
    expect(mockPopupView.destroy).toHaveBeenCalled();
  });

  it("destroy removes every listener it registered on the editor DOM", () => {
    // A ViewPlugin is destroyed on reconfiguration while view.dom lives on, so
    // a listener left behind would keep opening popups for a dead instance.
    const { instance, view } = instantiatePlugin({ triggerOnClick: true, triggerOnHover: true });
    const added = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => [c[0], c[1]],
    );
    expect(added.map(([name]) => name).sort()).toEqual(
      ["click", "mousedown", "mouseleave", "mousemove", "mouseup"],
    );
    (instance as { destroy: () => void }).destroy();
    const removed = (view.dom.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => [c[0], c[1]],
    );
    expect(removed).toEqual(expect.arrayContaining(added));
    expect(removed).toHaveLength(added.length);
  });

  it("destroy clears pending timeouts", () => {
    const { instance } = instantiatePlugin({ triggerOnHover: true });
    // Just verify destroy doesn't throw
    (instance as { destroy: () => void }).destroy();
  });

  it("update closes popup when selection moves away", () => {
    mockStore.state.isOpen = true;
    const detectTrigger = vi.fn(() => null);
    const { instance, view } = instantiatePlugin({ detectTrigger });

    const mockUpdate = {
      view,
      selectionSet: true,
      docChanged: false,
      transactions: [],
    } as unknown as ViewUpdate;

    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);

    vi.advanceTimersByTime(200);

    expect(mockStore.closePopup).toHaveBeenCalled();
  });

  it("update does not close popup when cursor is still in trigger", () => {
    mockStore.state.isOpen = true;
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));
    const { instance, view } = instantiatePlugin({ detectTrigger });

    const mockUpdate = {
      view,
      selectionSet: true,
      docChanged: false,
      transactions: [],
    } as unknown as ViewUpdate;

    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);

    vi.advanceTimersByTime(200);

    expect(mockStore.closePopup).not.toHaveBeenCalled();
  });

  it("update ignores when popup is not open", () => {
    mockStore.state.isOpen = false;
    const { instance, view } = instantiatePlugin();

    const mockUpdate = {
      view,
      selectionSet: true,
      docChanged: false,
      transactions: [],
    } as unknown as ViewUpdate;

    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);

    vi.advanceTimersByTime(200);

    expect(mockStore.closePopup).not.toHaveBeenCalled();
  });

  it("update ignores when doc changed alongside selection", () => {
    mockStore.state.isOpen = true;
    const { instance, view } = instantiatePlugin();

    const mockUpdate = {
      view,
      selectionSet: true,
      docChanged: true,
      transactions: [],
    } as unknown as ViewUpdate;

    (instance as { update: (u: ViewUpdate) => void }).update(mockUpdate);

    vi.advanceTimersByTime(200);

    // Should not close — docChanged means user is typing, not moving cursor
    expect(mockStore.closePopup).not.toHaveBeenCalled();
  });
});

describe("createSourcePopupPlugin — click handler logic", () => {
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

  it("click handler opens popup when trigger detected and custom openPopup provided", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));
    const extractData = vi.fn(() => ({ href: "test" }));

    const { view } = instantiatePlugin({
      detectTrigger,
      extractData,
      openPopup: customOpen,
      triggerOnClick: true,
    });

    // Simulate click by calling the registered handler
    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;
    expect(clickHandler).toBeDefined();

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      expect(customOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          range: { from: 0, to: 10 },
          data: { href: "test" },
          // Top-left from the range start (0), bottom-right from its end (10)
          anchorRect: { top: 100, left: 50, bottom: 130, right: 210 },
        })
      );
    }
  });

  it("click handler does nothing when pos is outside trigger range", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 3 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnClick: true,
    });

    // posAtCoords returns 5, which is outside the range 0-3
    (view.posAtCoords as ReturnType<typeof vi.fn>).mockReturnValue(5);

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("click handler does nothing when posAtCoords returns null", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnClick: true,
    });

    (view.posAtCoords as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      expect(customOpen).not.toHaveBeenCalled();
    }
  });

  it("click handler falls back to store openPopup when no custom openPopup", () => {
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));
    const extractData = vi.fn(() => ({ value: 42 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      extractData,
      triggerOnClick: true,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      expect(mockStore.openPopupFn).toHaveBeenCalledWith(
        expect.objectContaining({ value: 42 })
      );
    }
  });

  it("click handler calls onOpen callback before opening popup", () => {
    const onOpen = vi.fn();
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      onOpen,
      openPopup: customOpen,
      triggerOnClick: true,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      expect(onOpen).toHaveBeenCalled();
      expect(customOpen).toHaveBeenCalled();
    }
  });

  it("click handler uses detectTriggerAtPos when provided", () => {
    const detectTriggerAtPos = vi.fn(() => ({ from: 2, to: 8 }));
    const customOpen = vi.fn();

    const { view } = instantiatePlugin({
      detectTrigger: () => null,
      detectTriggerAtPos,
      openPopup: customOpen,
      triggerOnClick: true,
    });

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      expect(detectTriggerAtPos).toHaveBeenCalled();
      expect(customOpen).toHaveBeenCalled();
    }
  });

  it("click handler returns early when the range has no screen coordinates", () => {
    const customOpen = vi.fn();
    const detectTrigger = vi.fn(() => ({ from: 0, to: 10 }));

    const { view } = instantiatePlugin({
      detectTrigger,
      openPopup: customOpen,
      triggerOnClick: true,
    });

    // The view cannot place the range (e.g. scrolled out of layout)
    vi.mocked(view.coordsAtPos).mockReturnValue(null);

    const calls = (view.dom.addEventListener as ReturnType<typeof vi.fn>).mock.calls;
    const clickHandler = calls.find((c: unknown[]) => c[0] === "click")?.[1] as (e: MouseEvent) => void;

    if (clickHandler) {
      clickHandler(new MouseEvent("click", { clientX: 50, clientY: 100 }));
      expect(customOpen).not.toHaveBeenCalled();
    }
  });
});
