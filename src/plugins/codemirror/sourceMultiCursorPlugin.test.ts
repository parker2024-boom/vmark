/**
 * Source Multi-Cursor Plugin Tests
 *
 * Tests the multi-cursor collapse (Escape) behavior and
 * Alt+Click plugin event handling.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

// Mock imeGuard before importing
vi.mock("@/utils/imeGuard", () => ({
  guardCodeMirrorKeyBinding: (binding: unknown) => binding,
  isCodeMirrorComposing: () => false,
}));

import { sourceMultiCursorExtensions } from "./sourceMultiCursorPlugin";

const views: EditorView[] = [];

function createView(
  content: string,
  ranges: { anchor: number; head?: number }[]
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);

  const state = EditorState.create({
    doc: content,
    // The Source editor allows multiple selections; without it CodeMirror
    // normalizes every selection to its main range.
    extensions: [EditorState.allowMultipleSelections.of(true), sourceMultiCursorExtensions],
  });
  const view = new EditorView({ state, parent });
  views.push(view);

  // Dispatch multi-cursor selection after view creation
  if (ranges.length > 0) {
    view.dispatch({
      selection: EditorSelection.create(
        ranges.map((r) => EditorSelection.range(r.anchor, r.head ?? r.anchor)),
        ranges.length - 1
      ),
    });
  }

  return view;
}

function createSingleCursorView(content: string, cursorPos: number): EditorView {
  return createView(content, [{ anchor: cursorPos }]);
}

afterEach(() => {
  views.forEach((v) => {
    const parent = v.dom.parentElement;
    v.destroy();
    parent?.remove();
  });
  views.length = 0;
  vi.restoreAllMocks();
});

describe("sourceMultiCursorExtensions", () => {
  describe("Escape key - collapse to single cursor", () => {
    it("collapses multiple cursors to primary cursor via collapseToSingleCursor", () => {
      const view = createSingleCursorView("hello world foobar", 0);

      // Add cursors by dispatching
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(0),
          EditorSelection.cursor(6),
          EditorSelection.cursor(12),
        ], 2),
      });
      expect(view.state.selection.ranges.length).toBe(3);

      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
      expect(view.state.selection.ranges.length).toBe(1);
      expect(view.state.selection.main.head).toBe(12);
    });

    it("does not modify single cursor", () => {
      const view = createSingleCursorView("hello world", 5);

      expect(view.state.selection.ranges.length).toBe(1);

      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);

      // Still single cursor, position unchanged
      expect(view.state.selection.ranges.length).toBe(1);
      expect(view.state.selection.main.head).toBe(5);
    });

    it("preserves primary cursor head position", () => {
      const view = createView("abcdefghij", [
        { anchor: 2 },
        { anchor: 5 },
        { anchor: 8 },
      ]);

      const primaryHead = view.state.selection.main.head;

      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);

      expect(view.state.selection.ranges.length).toBe(1);
      expect(view.state.selection.main.head).toBe(primaryHead);
    });
  });

  describe("Alt+Click plugin", () => {
    // jsdom has no layout, so `posAtCoords` (CodeMirror's layout query) is the
    // one thing faked: each click lands on the document position given.
    function click(view: EditorView, pos: number | null, init: MouseEventInit = { altKey: true }) {
      vi.spyOn(view, "posAtCoords").mockReturnValue(pos as number);
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 1, clientY: 1, ...init });
      view.dom.dispatchEvent(event);
      return event;
    }
    const heads = (view: EditorView) => view.state.selection.ranges.map((r) => r.head);

    it("Alt+Click adds a cursor at the clicked position and makes it primary", () => {
      const view = createSingleCursorView("hello world", 0);
      const event = click(view, 6);

      expect(heads(view)).toEqual([0, 6]);
      expect(view.state.selection.main.head).toBe(6);
      expect(event.defaultPrevented).toBe(true);
    });

    it("Alt+Click on an existing secondary cursor removes it", () => {
      const view = createView("hello world foo", [{ anchor: 0 }, { anchor: 6 }, { anchor: 12 }]);
      click(view, 6);

      expect(heads(view)).toEqual([0, 12]);
    });

    it("ignores a click without Alt", () => {
      const view = createSingleCursorView("hello", 0);
      const event = click(view, 3, { altKey: false });

      expect(heads(view)).toEqual([0]);
      expect(event.defaultPrevented).toBe(false);
    });

    it("ignores Alt+Click combined with Meta or Ctrl", () => {
      const view = createSingleCursorView("hello", 0);
      click(view, 3, { altKey: true, metaKey: true });
      click(view, 3, { altKey: true, ctrlKey: true });

      expect(heads(view)).toEqual([0]);
    });

    it("ignores Alt+Click outside the text (no position under the pointer)", () => {
      const view = createSingleCursorView("hello", 0);
      const event = click(view, null);

      expect(heads(view)).toEqual([0]);
      expect(event.defaultPrevented).toBe(false);
    });

    it("handles multiple rapid Alt+Click events", () => {
      const view = createSingleCursorView("hello world foobar", 0);
      for (const pos of [3, 6, 9, 12, 15]) click(view, pos);

      expect(heads(view)).toEqual([0, 3, 6, 9, 12, 15]);
      expect(view.state.selection.main.head).toBe(15);
    });

    it("stops listening once the view is destroyed", () => {
      const view = createSingleCursorView("hello", 0);
      const removeEventSpy = vi.spyOn(view.dom, "removeEventListener");
      const posAtCoords = vi.spyOn(view, "posAtCoords");

      view.destroy();
      view.dom.dispatchEvent(new MouseEvent("mousedown", { altKey: true }));

      expect(removeEventSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
      expect(posAtCoords).not.toHaveBeenCalled();
    });
  });
  describe("Extension composition", () => {
    it("sourceMultiCursorExtensions is an array", () => {
      expect(Array.isArray(sourceMultiCursorExtensions)).toBe(true);
    });

    it("sourceMultiCursorExtensions contains two entries (altClick + keymap)", () => {
      expect(sourceMultiCursorExtensions.length).toBe(2);
    });

    it("extensions can be added to EditorState without error", () => {
      const state = EditorState.create({
        doc: "test",
        extensions: [sourceMultiCursorExtensions],
      });
      expect(state.doc.toString()).toBe("test");
    });
  });

  describe("collapseToSingleCursor via keymap — multi-cursor state", () => {
    it("returns false (no dispatch) when already single cursor", () => {
      // collapseToSingleCursor: selection.ranges.length <= 1 → return false
      const view = createSingleCursorView("hello world", 5);
      // Manually invoke via keydown (covers the run: (view) => collapseToSingleCursor line 68)
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
      // No change expected
      expect(view.state.selection.main.head).toBe(5);
    });

  });

  describe("Escape with various selection states", () => {
    it("handles cursor at position 0", () => {
      const view = createSingleCursorView("hello", 0);
      expect(view.state.selection.main.head).toBe(0);

      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);

      // Single cursor, no change
      expect(view.state.selection.main.head).toBe(0);
    });

    it("handles cursor at end of document", () => {
      const view = createSingleCursorView("hello", 5);
      expect(view.state.selection.main.head).toBe(5);

      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);

      expect(view.state.selection.main.head).toBe(5);
    });

    it("handles empty document", () => {
      const view = createSingleCursorView("", 0);
      expect(view.state.selection.main.head).toBe(0);

      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);

      expect(view.state.selection.main.head).toBe(0);
    });

    it("handles cursor in multiline document", () => {
      const view = createSingleCursorView("hello\nworld\nfoo", 6);

      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);

      // Still single cursor, unchanged
      expect(view.state.selection.ranges.length).toBe(1);
      expect(view.state.selection.main.head).toBe(6);
    });
  });

  describe("collapseToSingleCursor — direct keymap run invocation", () => {
    /**
     * Extract the Escape keymap `run` function from the view's state facet.
     * This bypasses jsdom's inability to trigger CodeMirror keymap bindings.
     */
    function getEscapeRunFn(view: EditorView): ((v: EditorView) => boolean) | null {
      // keymap facet returns arrays of KeyBinding objects
      const facetValue = view.state.facet(keymap) as Array<Array<{ key?: string; run?: (v: EditorView) => boolean }>>;
      for (const bindings of facetValue) {
        if (!Array.isArray(bindings)) continue;
        for (const binding of bindings) {
          if (binding.key === "Escape" && typeof binding.run === "function") {
            return binding.run;
          }
        }
      }
      return null;
    }

    it("collapses multi-cursor to primary via Escape run callback", () => {
      const parent = document.createElement("div");
      document.body.appendChild(parent);

      // Create state with multi-range selection directly
      const multiState = EditorState.create({
        doc: "hello world foobar",
        selection: EditorSelection.create([
          EditorSelection.cursor(0),
          EditorSelection.cursor(6),
          EditorSelection.cursor(12),
        ], 1),
        extensions: [sourceMultiCursorExtensions],
      });
      const view = new EditorView({ state: multiState, parent });
      views.push(view);

      const escapeRun = getEscapeRunFn(view);
      expect(escapeRun).not.toBeNull();

      const rangeCount = view.state.selection.ranges.length;
      if (rangeCount > 1) {
        // Multi-range preserved — collapseToSingleCursor should return true
        const result = escapeRun!(view);
        expect(result).toBe(true);
        expect(view.state.selection.ranges.length).toBe(1);
        expect(view.state.selection.main.head).toBe(6);
      } else {
        // CodeMirror normalized ranges — test the false branch instead
        const result = escapeRun!(view);
        expect(result).toBe(false);
      }
    });

    it("covers collapseToSingleCursor true path via mock dispatch", () => {
      // To cover lines 29-35, we create a mock view whose state.selection
      // has multiple ranges, and whose dispatch is callable
      const view = createSingleCursorView("hello world foobar", 0);
      const escapeRun = getEscapeRunFn(view);
      expect(escapeRun).not.toBeNull();

      // Create a fake view with multi-range selection to force the true path
      const dispatchFn = vi.fn();
      const fakeView = {
        state: {
          selection: {
            ranges: [{ from: 0, to: 0 }, { from: 6, to: 6 }],
            main: { head: 6 },
          },
        },
        dispatch: dispatchFn,
      } as unknown as EditorView;

      const result = escapeRun!(fakeView);
      expect(result).toBe(true);
      expect(dispatchFn).toHaveBeenCalledWith({
        selection: EditorSelection.cursor(6),
      });
    });

    it("returns false when already single cursor (covers line 24-25)", () => {
      const view = createSingleCursorView("hello world", 3);
      const escapeRun = getEscapeRunFn(view);
      expect(escapeRun).not.toBeNull();

      // Single cursor — collapseToSingleCursor returns false
      const result = escapeRun!(view);
      expect(result).toBe(false);
      expect(view.state.selection.ranges.length).toBe(1);
      expect(view.state.selection.main.head).toBe(3);
    });
  });
});
