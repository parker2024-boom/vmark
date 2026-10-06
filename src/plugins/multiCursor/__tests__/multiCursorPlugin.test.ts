import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, SelectionRange, TextSelection } from "@tiptap/pm/state";
import {
  multiCursorPlugin,
  multiCursorPluginKey,
} from "../multiCursorPlugin";
import { MultiSelection } from "@/plugins/shared/MultiSelection";

// Simple schema for testing
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
});

function createDoc(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
}

function createState(text: string) {
  return EditorState.create({
    doc: createDoc(text),
    schema,
    plugins: [multiCursorPlugin()],
  });
}

function createMultiCursorState(
  text: string,
  positions: Array<{ from: number; to: number }>
) {
  const state = createState(text);
  const doc = state.doc;
  const ranges = positions.map((p) => {
    const $from = doc.resolve(p.from);
    const $to = doc.resolve(p.to);
    return new SelectionRange($from, $to);
  });
  const multiSel = new MultiSelection(ranges, 0);
  return state.apply(state.tr.setSelection(multiSel));
}

describe("multiCursorPlugin", () => {
  describe("plugin creation", () => {
    it("creates plugin with key", () => {
      const plugin = multiCursorPlugin();
      expect(plugin.spec.key).toBe(multiCursorPluginKey);
    });

    it("integrates with EditorState", () => {
      const state = createState("hello world");
      expect(state.plugins).toHaveLength(1);
      expect(multiCursorPluginKey.getState(state)).toBeDefined();
    });
  });

  describe("plugin state", () => {
    it("has empty initial state", () => {
      const state = createState("hello world");
      const pluginState = multiCursorPluginKey.getState(state);
      expect(pluginState).toEqual({ isActive: false, selectionHistory: [] });
    });

    it("tracks when MultiSelection is active", () => {
      const state = createState("hello world");
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);

      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      const tr = state.tr.setSelection(multiSel);
      const newState = state.apply(tr);
      const pluginState = multiCursorPluginKey.getState(newState);

      expect(pluginState?.isActive).toBe(true);
    });

    it("sets isActive to false when selection is not MultiSelection", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      expect(multiCursorPluginKey.getState(state)?.isActive).toBe(true);

      // Collapse to single selection
      const tr = state.tr.setSelection(TextSelection.create(state.doc, 1));
      const newState = state.apply(tr);
      expect(multiCursorPluginKey.getState(newState)?.isActive).toBe(false);
    });
  });

  describe("selection history - pushHistory", () => {
    it("pushes single selection onto history when meta.pushHistory is set", () => {
      const state = createState("hello world");
      // Set up a MultiSelection and push history
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);
      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      const tr = state.tr
        .setSelection(multiSel)
        .setMeta(multiCursorPluginKey, { pushHistory: true });
      const newState = state.apply(tr);
      const pluginState = multiCursorPluginKey.getState(newState);

      expect(pluginState?.selectionHistory).toHaveLength(1);
      // The history entry should be the old selection (single cursor at pos 1)
      expect(pluginState?.selectionHistory[0].ranges).toHaveLength(1);
      expect(pluginState?.selectionHistory[0].primaryIndex).toBe(0);
    });

    it("pushes MultiSelection onto history", () => {
      // Start with a MultiSelection
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);

      // Add another cursor with pushHistory
      const doc = state.doc;
      const $pos3 = doc.resolve(4);
      const existingRanges = (state.selection as MultiSelection).ranges;
      const newRanges = [...existingRanges, new SelectionRange($pos3, $pos3)];
      const newSel = new MultiSelection(newRanges, 2);

      const tr = state.tr
        .setSelection(newSel)
        .setMeta(multiCursorPluginKey, { pushHistory: true });
      const newState = state.apply(tr);
      const pluginState = multiCursorPluginKey.getState(newState);

      expect(pluginState?.selectionHistory).toHaveLength(1);
      // Old selection had 2 ranges
      expect(pluginState?.selectionHistory[0].ranges).toHaveLength(2);
    });

    it("caps history at MAX_SELECTION_HISTORY (50)", () => {
      let state = createState("hello world");
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);
      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      // Push 51 history entries to trigger the slice(-MAX_SELECTION_HISTORY) path
      for (let i = 0; i < 51; i++) {
        const tr = state.tr
          .setSelection(multiSel)
          .setMeta(multiCursorPluginKey, { pushHistory: true });
        state = state.apply(tr);
      }

      const pluginState = multiCursorPluginKey.getState(state);
      expect(pluginState?.selectionHistory.length).toBe(50);
    });
  });

  describe("selection history - popHistory", () => {
    it("replaces history stack when meta.popHistory is set", () => {
      // Build up some history
      const state = createState("hello world");
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);
      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      const tr1 = state.tr
        .setSelection(multiSel)
        .setMeta(multiCursorPluginKey, { pushHistory: true });
      const stateWithHistory = state.apply(tr1);

      // Now pop history
      const tr2 = stateWithHistory.tr.setMeta(multiCursorPluginKey, {
        popHistory: [],
      });
      const newState = stateWithHistory.apply(tr2);
      const pluginState = multiCursorPluginKey.getState(newState);

      expect(pluginState?.selectionHistory).toEqual([]);
    });
  });

  describe("selection history - clearing", () => {
    it("clears history on document changes", () => {
      // Set up state with history
      const state = createState("hello world");
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);
      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      const tr1 = state.tr
        .setSelection(multiSel)
        .setMeta(multiCursorPluginKey, { pushHistory: true });
      const stateWithHistory = state.apply(tr1);
      expect(
        multiCursorPluginKey.getState(stateWithHistory)?.selectionHistory.length
      ).toBeGreaterThan(0);

      // Make a text change
      const tr2 = stateWithHistory.tr.insertText("x", 1);
      const newState = stateWithHistory.apply(tr2);
      const pluginState = multiCursorPluginKey.getState(newState);

      expect(pluginState?.selectionHistory).toEqual([]);
    });

    it("clears history when leaving multi-cursor mode", () => {
      // Set up state with history
      const state = createState("hello world");
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);
      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      const tr1 = state.tr
        .setSelection(multiSel)
        .setMeta(multiCursorPluginKey, { pushHistory: true });
      const stateWithHistory = state.apply(tr1);

      // Switch to single selection (leave multi-cursor mode)
      const tr2 = stateWithHistory.tr.setSelection(
        TextSelection.create(stateWithHistory.doc, 1)
      );
      const newState = stateWithHistory.apply(tr2);
      const pluginState = multiCursorPluginKey.getState(newState);

      expect(pluginState?.selectionHistory).toEqual([]);
      expect(pluginState?.isActive).toBe(false);
    });

    it("preserves history on non-doc-changing transactions while in multi-cursor mode", () => {
      const state = createState("hello world");
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);
      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      const tr1 = state.tr
        .setSelection(multiSel)
        .setMeta(multiCursorPluginKey, { pushHistory: true });
      const stateWithHistory = state.apply(tr1);

      const historyBefore = multiCursorPluginKey.getState(stateWithHistory)
        ?.selectionHistory;
      expect(historyBefore?.length).toBeGreaterThan(0);

      // Apply a non-doc-changing transaction that keeps MultiSelection
      const tr2 = stateWithHistory.tr.setMeta("test", true);
      const newState = stateWithHistory.apply(tr2);
      const pluginState = multiCursorPluginKey.getState(newState);

      expect(pluginState?.selectionHistory).toEqual(historyBefore);
    });
  });

  describe("appendTransaction", () => {
    it("maintains MultiSelection through transactions", () => {
      const state = createState("hello world");
      const doc = state.doc;
      const $pos1 = doc.resolve(1);
      const $pos2 = doc.resolve(7);

      const ranges = [
        new SelectionRange($pos1, $pos1),
        new SelectionRange($pos2, $pos2),
      ];
      const multiSel = new MultiSelection(ranges, 0);

      // Set multi-selection
      const tr1 = state.tr.setSelection(multiSel);
      const stateWithMulti = state.apply(tr1);

      // Make a non-selection-changing transaction
      const tr2 = stateWithMulti.tr.setMeta("test", true);
      const finalState = stateWithMulti.apply(tr2);

      // MultiSelection should be maintained
      expect(finalState.selection).toBeInstanceOf(MultiSelection);
    });
  });

  describe("props - handleTextInput", () => {
    it("returns false for non-MultiSelection", () => {
      const state = createState("hello world");
      const plugin = state.plugins[0];
      const handleTextInput = plugin.props.handleTextInput;
      expect(handleTextInput).toBeDefined();

      const mockView = {
        state,
        dispatch: vi.fn(),
        composing: false,
      } as never;

      const result = handleTextInput!(mockView, 1, 1, "x");
      expect(result).toBe(false);
    });

    it("returns false when composing", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const handleTextInput = plugin.props.handleTextInput;

      const mockView = {
        state,
        dispatch: vi.fn(),
        composing: true,
      } as never;

      const result = handleTextInput!(mockView, 1, 1, "x");
      expect(result).toBe(false);
    });

    it("dispatches transaction for MultiSelection text input", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const handleTextInput = plugin.props.handleTextInput;
      const dispatch = vi.fn();

      const mockView = {
        state,
        dispatch,
        composing: false,
      } as never;

      const result = handleTextInput!(mockView, 1, 1, "x");
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalled();
    });
  });

  describe("props - handleClick", () => {
    it("returns false when alt key is not pressed", () => {
      const state = createState("hello world");
      const plugin = state.plugins[0];
      const handleClick = plugin.props.handleClick;
      expect(handleClick).toBeDefined();

      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      const event = { altKey: false } as MouseEvent;
      const result = handleClick!(mockView, 3, event);
      expect(result).toBe(false);
    });

    it("adds cursor on Alt+Click", () => {
      const state = createState("hello world");
      // Set cursor at position 1
      const stateWithCursor = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, 1))
      );

      const plugin = stateWithCursor.plugins[0];
      const handleClick = plugin.props.handleClick;
      const dispatch = vi.fn();

      const mockView = {
        state: stateWithCursor,
        dispatch,
      } as never;

      const event = { altKey: true } as MouseEvent;
      const result = handleClick!(mockView, 7, event);
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalled();
    });

    it("returns false when Alt+Click at same position", () => {
      const state = createState("hello world");
      const stateWithCursor = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, 3))
      );

      const plugin = stateWithCursor.plugins[0];
      const handleClick = plugin.props.handleClick;
      const dispatch = vi.fn();

      const mockView = {
        state: stateWithCursor,
        dispatch,
      } as never;

      const event = { altKey: true } as MouseEvent;
      const result = handleClick!(mockView, 3, event);
      // addCursorAtPosition returns null when clicking same position
      expect(result).toBe(false);
    });
  });

  describe("props - handleKeyDown", () => {
    it("returns false for non-MultiSelection", () => {
      const state = createState("hello world");
      const plugin = state.plugins[0];
      const handleKeyDown = plugin.props.handleKeyDown;
      expect(handleKeyDown).toBeDefined();

      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      const event = new KeyboardEvent("keydown", { key: "Backspace" });
      const result = handleKeyDown!(mockView, event);
      expect(result).toBe(false);
    });

    it("returns false for IME key events", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const handleKeyDown = plugin.props.handleKeyDown;

      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      // IME keyCode is 229
      const event = new KeyboardEvent("keydown", {
        key: "Process",
        keyCode: 229,
      } as KeyboardEventInit);
      // Manually set isComposing since KeyboardEvent constructor may not support it
      Object.defineProperty(event, "isComposing", { value: true });
      const result = handleKeyDown!(mockView, event);
      expect(result).toBe(false);
    });

    it("handles Backspace in MultiSelection", () => {
      const state = createMultiCursorState("hello world", [
        { from: 2, to: 2 },
        { from: 8, to: 8 },
      ]);
      const plugin = state.plugins[0];
      const handleKeyDown = plugin.props.handleKeyDown;
      const dispatch = vi.fn();

      const mockView = {
        state,
        dispatch,
      } as never;

      const event = new KeyboardEvent("keydown", { key: "Backspace" });
      const result = handleKeyDown!(mockView, event);
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalled();
    });

    it("handles Delete in MultiSelection", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const handleKeyDown = plugin.props.handleKeyDown;
      const dispatch = vi.fn();

      const mockView = {
        state,
        dispatch,
      } as never;

      const event = new KeyboardEvent("keydown", { key: "Delete" });
      const result = handleKeyDown!(mockView, event);
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalled();
    });

    it("handles Enter in MultiSelection", () => {
      const state = createMultiCursorState("hello world", [
        { from: 3, to: 3 },
        { from: 8, to: 8 },
      ]);
      const plugin = state.plugins[0];
      const handleKeyDown = plugin.props.handleKeyDown;
      const dispatch = vi.fn();

      const mockView = {
        state,
        dispatch,
      } as never;

      const event = new KeyboardEvent("keydown", { key: "Enter" });
      const result = handleKeyDown!(mockView, event);
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalled();
    });

    it("returns null for unhandled keys in MultiSelection", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const handleKeyDown = plugin.props.handleKeyDown;
      const dispatch = vi.fn();

      const mockView = {
        state,
        dispatch,
      } as never;

      const event = new KeyboardEvent("keydown", { key: "Tab" });
      const result = handleKeyDown!(mockView, event);
      expect(result).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe("props - handlePaste", () => {
    it("returns false for non-MultiSelection", () => {
      const state = createState("hello world");
      const plugin = state.plugins[0];
      const handlePaste = plugin.props.handlePaste;
      expect(handlePaste).toBeDefined();

      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      const event = {
        clipboardData: { getData: () => "pasted text" },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = handlePaste!(mockView, event, {} as never);
      expect(result).toBe(false);
    });

    it("returns false when clipboard data is empty", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const handlePaste = plugin.props.handlePaste;

      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      const event = {
        clipboardData: { getData: () => "" },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = handlePaste!(mockView, event, {} as never);
      expect(result).toBe(false);
    });

    it("handles paste in MultiSelection", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const handlePaste = plugin.props.handlePaste;
      const dispatch = vi.fn();

      const mockView = {
        state,
        dispatch,
      } as never;

      const event = {
        clipboardData: { getData: () => "pasted" },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = handlePaste!(mockView, event, {} as never);
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe("props - handleDOMEvents (copy)", () => {
    it("returns false for non-MultiSelection on copy", () => {
      const state = createState("hello world");
      const plugin = state.plugins[0];
      const domEvents = plugin.props.handleDOMEvents;
      expect(domEvents?.copy).toBeDefined();

      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      const event = {
        clipboardData: { setData: vi.fn() },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = domEvents!.copy!(mockView, event);
      expect(result).toBe(false);
    });

    it("handles copy in MultiSelection with selected text", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 6 },
        { from: 7, to: 12 },
      ]);
      const plugin = state.plugins[0];
      const domEvents = plugin.props.handleDOMEvents;

      const setData = vi.fn();
      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      const event = {
        clipboardData: { setData },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = domEvents!.copy!(mockView, event);
      expect(result).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(setData).toHaveBeenCalledWith("text/plain", expect.any(String));
    });
  });

  describe("props - handleDOMEvents (cut)", () => {
    it("returns false for non-MultiSelection on cut", () => {
      const state = createState("hello world");
      const plugin = state.plugins[0];
      const domEvents = plugin.props.handleDOMEvents;
      expect(domEvents?.cut).toBeDefined();

      const mockView = {
        state,
        dispatch: vi.fn(),
      } as never;

      const event = {
        clipboardData: { setData: vi.fn() },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = domEvents!.cut!(mockView, event);
      expect(result).toBe(false);
    });

    it("handles cut in MultiSelection with selected text", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 6 },
        { from: 7, to: 12 },
      ]);
      const plugin = state.plugins[0];
      const domEvents = plugin.props.handleDOMEvents;
      const dispatch = vi.fn();

      const setData = vi.fn();
      const mockView = {
        state,
        dispatch,
      } as never;

      const event = {
        clipboardData: { setData },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = domEvents!.cut!(mockView, event);
      expect(result).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalled();
    });
  });

  describe("decorations", () => {
    it("provides decorations prop", () => {
      const state = createState("hello world");
      const plugin = state.plugins[0];
      expect(plugin.props.decorations).toBeDefined();
    });

    it("returns decorations for MultiSelection state", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const decorations = plugin.props.decorations!(state);
      expect(decorations).toBeDefined();
    });
  });

  describe("view() lifecycle — syncClass, update, destroy", () => {
    it("adds and removes multi-cursor-active class on the DOM element", () => {
      // The view() hook manages a CSS class on editorView.dom.
      // We simulate by calling the view() method returned by the plugin spec.
      const state = createState("hello world");
      const plugin = state.plugins[0];
      const spec = (plugin as never as { spec: { view: (v: unknown) => { update: (v: unknown) => void; destroy: () => void } } }).spec;

      const dom = document.createElement("div");
      const fakeView = { state, dom };

      const viewReturn = spec.view(fakeView);

      // On init: state has TextSelection, so multi-cursor-active should NOT be set
      expect(dom.classList.contains("multi-cursor-active")).toBe(false);

      // On update with MultiSelection state
      const multiState = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      viewReturn.update({ state: multiState });
      expect(dom.classList.contains("multi-cursor-active")).toBe(true);

      // On update back to single selection
      viewReturn.update({ state });
      expect(dom.classList.contains("multi-cursor-active")).toBe(false);

      // On destroy
      // First set it active again
      viewReturn.update({ state: multiState });
      expect(dom.classList.contains("multi-cursor-active")).toBe(true);
      viewReturn.destroy();
      expect(dom.classList.contains("multi-cursor-active")).toBe(false);
    });
  });

  describe("handlePaste — edge cases", () => {
    it("returns false when clipboard text is empty", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const dispatch = vi.fn();
      const mockView = { state, dispatch } as never;

      // clipboardData.getData returns empty string
      const event = {
        clipboardData: { getData: () => "" },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = plugin.props.handlePaste!(mockView, event, {} as never);
      expect(result).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("returns false when clipboardData is null", () => {
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const dispatch = vi.fn();
      const mockView = { state, dispatch } as never;

      // clipboardData is null — getData falls back to ""
      const event = {
        clipboardData: null,
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = plugin.props.handlePaste!(mockView, event, {} as never);
      expect(result).toBe(false);
    });
  });

  describe("copy — edge cases", () => {
    it("returns false for single collapsed MultiSelection (empty clipboard text)", () => {
      // A MultiSelection with exactly 1 collapsed range returns "" from getTextContent
      const state = createState("hello world");
      const doc = state.doc;
      const $pos = doc.resolve(1);
      const range = new SelectionRange($pos, $pos);
      const multiSel = new MultiSelection([range], 0);
      const singleMultiState = state.apply(state.tr.setSelection(multiSel));

      const plugin = singleMultiState.plugins[0];
      const domEvents = plugin.props.handleDOMEvents;
      const mockView = { state: singleMultiState, dispatch: vi.fn() } as never;

      const setData = vi.fn();
      const event = {
        clipboardData: { setData },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = domEvents!.copy!(mockView, event);
      // getTextContent for 1 collapsed cursor = "" → !text is true → returns false
      expect(result).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(setData).not.toHaveBeenCalled();
    });
  });

  describe("cut — edge cases", () => {
    it("returns false for MultiSelection with all collapsed cursors (no text to cut)", () => {
      // All cursors collapsed → handleMultiCursorCut returns null (hasNonEmptyRange is false)
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const domEvents = plugin.props.handleDOMEvents;
      const dispatch = vi.fn();
      const mockView = { state, dispatch } as never;

      const setData = vi.fn();
      const event = {
        clipboardData: { setData },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = domEvents!.cut!(mockView, event);
      // handleMultiCursorCut returns null for all-collapsed → result is false
      expect(result).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("still sets clipboard data even when cut tr is null", () => {
      // 2 collapsed cursors: getTextContent returns "\n" (truthy),
      // but handleMultiCursorCut returns null (no non-empty ranges)
      // So text is set via setData, but tr is null → returns false
      const state = createMultiCursorState("hello world", [
        { from: 1, to: 1 },
        { from: 7, to: 7 },
      ]);
      const plugin = state.plugins[0];
      const domEvents = plugin.props.handleDOMEvents;
      const dispatch = vi.fn();
      const mockView = { state, dispatch } as never;

      const setData = vi.fn();
      const event = {
        clipboardData: { setData },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      const result = domEvents!.cut!(mockView, event);
      // text = "\n" (truthy for 2 collapsed ranges) → setData is called
      // handleMultiCursorCut returns null → returns false
      expect(setData).toHaveBeenCalledWith("text/plain", "\n");
      expect(result).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
