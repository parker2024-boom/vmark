/**
 * Shared fixtures for the createSourcePopupPlugin test files: a minimal popup
 * store, a popup view stub and an editor view stub.
 */
import { vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import type { PopupStoreBase, StoreApi, SourcePopupView } from "../SourcePopupView";

export interface TestState extends PopupStoreBase {
  openPopup?: (data: unknown) => void;
}

export function createMockStore(): {
  store: StoreApi<TestState>;
  state: TestState;
  closePopup: ReturnType<typeof vi.fn>;
  openPopupFn: ReturnType<typeof vi.fn>;
} {
  const closePopup = vi.fn();
  const openPopupFn = vi.fn();
  const state: TestState = {
    isOpen: false,
    anchorRect: null,
    closePopup,
    openPopup: openPopupFn,
  };
  const subscribers: Array<(s: TestState) => void> = [];
  const store: StoreApi<TestState> = {
    getState: () => state,
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
  };
  return { store, state, closePopup, openPopupFn };
}

export function createMockPopupView(): SourcePopupView<TestState> {
  return {
    destroy: vi.fn(),
  } as unknown as SourcePopupView<TestState>;
}

export function createMockEditorView(): EditorView {
  const dom = document.createElement("div");
  dom.addEventListener = vi.fn();
  dom.removeEventListener = vi.fn();
  return {
    dom,
    posAtCoords: vi.fn(() => 5),
    state: {
      doc: { lineAt: () => ({ from: 0, to: 20, text: "hello world" }) },
      selection: { main: { from: 5, to: 5 } },
    },
    // Position-dependent, so an anchor rect shows which range it was built from.
    coordsAtPos: vi.fn((pos: number) => ({ top: 100 + pos, left: 50 + pos, bottom: 120 + pos, right: 200 + pos })),
  } as unknown as EditorView;
}
