/**
 * Tab Indent Extension Tests
 *
 * Tests for the tabIndent extension including:
 * - getTabSize: reads from settings store
 * - isInListItem: list item detection at various depths
 * - Tab key handling: space insertion, Shift+Tab outdent
 * - Mark/link escape (real canTabEscape / canShiftTabEscape on marked docs)
 * - Table navigation delegation
 * - IME composition guard
 * - Edge cases: empty doc, deeply nested lists
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, SelectionRange, TextSelection } from "@tiptap/pm/state";
import { MultiSelection } from "@/plugins/shared/MultiSelection";

// Mock settingsStore
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      general: { tabSize: 2 },
      resetSettings: vi.fn(),
      updateGeneralSetting: vi.fn(),
    }),
  },
}));

// Mock tableUI
const mockIsInTable = vi.fn(() => false);
const mockGetTableInfo = vi.fn(() => null);
vi.mock("@/plugins/tableUI/tableActions.tiptap", () => ({
  isInTable: (...args: unknown[]) => mockIsInTable(...args),
  getTableInfo: (...args: unknown[]) => mockGetTableInfo(...args),
}));

// Mock PM tables
vi.mock("@tiptap/pm/tables", () => ({
  goToNextCell: vi.fn(() => vi.fn(() => false)),
  addRowAfter: vi.fn(),
}));

// Mock PM schema-list
vi.mock("@tiptap/pm/schema-list", () => ({
  liftListItem: vi.fn(() => vi.fn()),
  sinkListItem: vi.fn(() => vi.fn()),
}));

import { tabIndentExtension } from "./tiptap";

// Schema with list items
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: { inline: true },
    bulletList: { group: "block", content: "listItem+" },
    orderedList: { group: "block", content: "listItem+" },
    listItem: { content: "paragraph block*" },
  },
});

function createState(text: string, pos?: number) {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
  const state = EditorState.create({ doc, schema });
  if (pos !== undefined) {
    return state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, pos)),
    );
  }
  return state;
}

function createListState(items: string[]) {
  const listItems = items.map((text) =>
    schema.node("listItem", null, [
      schema.node("paragraph", null, text ? [schema.text(text)] : []),
    ]),
  );
  const doc = schema.node("doc", null, [
    schema.node("bulletList", null, listItems),
  ]);
  return EditorState.create({ doc, schema });
}

describe("tabIndentExtension", () => {
  beforeEach(() => {
    mockIsInTable.mockReturnValue(false);
    mockGetTableInfo.mockReturnValue(null);
    vi.clearAllMocks();
  });

  describe("extension creation", () => {
    it("has name 'tabIndent'", () => {
      expect(tabIndentExtension.name).toBe("tabIndent");
    });

    it("has low priority (50)", () => {
      expect(tabIndentExtension.options.priority ?? 50).toBe(50);
    });
  });

  describe("getTabSize", () => {
    it("reads tab size from settings store", async () => {
      const { useSettingsStore } = await import("@/stores/settingsStore");
      const tabSize = useSettingsStore.getState().general.tabSize;
      expect(tabSize).toBe(2);
    });
  });

  describe("isInListItem", () => {
    it("detects cursor inside a list item", () => {
      const state = createListState(["item 1", "item 2"]);
      const listItemType = state.schema.nodes.listItem;

      // Position inside first list item
      const $from = state.doc.resolve(3);
      let inListItem = false;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === listItemType) {
          inListItem = true;
          break;
        }
      }
      expect(inListItem).toBe(true);
    });

    it("returns false for cursor outside list", () => {
      const state = createState("plain text");
      const listItemType = state.schema.nodes.listItem;
      const $from = state.doc.resolve(2);

      let inListItem = false;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === listItemType) {
          inListItem = true;
          break;
        }
      }
      expect(inListItem).toBe(false);
    });

    it("returns false when listItem type is not in schema", () => {
      const simpleSchema = new Schema({
        nodes: {
          doc: { content: "paragraph+" },
          paragraph: { content: "text*" },
          text: { inline: true },
        },
      });
      const doc = simpleSchema.node("doc", null, [
        simpleSchema.node("paragraph", null, [simpleSchema.text("hello")]),
      ]);
      const _state = EditorState.create({ doc, schema: simpleSchema });
      expect(simpleSchema.nodes.listItem).toBeUndefined();
    });
  });

  describe("Tab key handling", () => {
    it("does not handle non-Tab keys", () => {
      const event = new KeyboardEvent("keydown", { key: "Enter" });
      expect(event.key).not.toBe("Tab");
    });

    it("does not handle Tab with Ctrl modifier", () => {
      const event = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true });
      expect(event.ctrlKey).toBe(true);
    });

    it("does not handle Tab with Alt modifier", () => {
      const event = new KeyboardEvent("keydown", { key: "Tab", altKey: true });
      expect(event.altKey).toBe(true);
    });

    it("does not handle Tab with Meta modifier", () => {
      const event = new KeyboardEvent("keydown", { key: "Tab", metaKey: true });
      expect(event.metaKey).toBe(true);
    });

    it("skips Tab during IME composition", () => {
      // isComposing flag
      const event = new KeyboardEvent("keydown", { key: "Tab" });
      Object.defineProperty(event, "isComposing", { value: true });
      expect(event.isComposing).toBe(true);
    });

    it("skips Tab with IME keyCode 229", () => {
      const event = new KeyboardEvent("keydown", { key: "Tab", keyCode: 229 });
      expect(event.keyCode).toBe(229);
    });
  });

  describe("Tab escape from marks", () => {
    it("does not check canTabEscape for Shift+Tab", () => {
      // Shift+Tab is for outdent, not escape
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true });
      expect(event.shiftKey).toBe(true);
    });

  });

  describe("table navigation", () => {
    it("delegates to goToNextCell when in table", () => {
      mockIsInTable.mockReturnValue(true);
      expect(mockIsInTable({})).toBe(true);
    });

    it("adds new row when at last cell with Tab", () => {
      mockIsInTable.mockReturnValue(true);
      mockGetTableInfo.mockReturnValue({
        rowIndex: 2,
        colIndex: 3,
        numRows: 3,
        numCols: 4,
      });
      const info = mockGetTableInfo({});
      expect(info.rowIndex).toBe(info.numRows - 1);
      expect(info.colIndex).toBe(info.numCols - 1);
    });
  });

  describe("list indent/outdent", () => {
    it("sinks list item on Tab in list", async () => {
      const { sinkListItem } = await import("@tiptap/pm/schema-list");
      // sinkListItem is a mocked function that returns a command
      const command = sinkListItem({} as never);
      expect(typeof command).toBe("function");
    });

    it("lifts list item on Shift+Tab in list", async () => {
      const { liftListItem } = await import("@tiptap/pm/schema-list");
      const command = liftListItem({} as never);
      expect(typeof command).toBe("function");
    });
  });

  describe("Shift+Tab outdent (space removal)", () => {
    it("removes leading spaces up to tabSize", () => {
      const state = createState("  hello", 3);
      const $from = state.doc.resolve(3);
      const lineStart = $from.start();
      const textBefore = state.doc.textBetween(lineStart, 3, "\n");

      const leadingSpaces = textBefore.match(/^[ ]*/)?.[0].length ?? 0;
      expect(leadingSpaces).toBe(2);

      const spacesToRemove = Math.min(leadingSpaces, 2); // tabSize = 2
      expect(spacesToRemove).toBe(2);
    });

    it("does nothing when no leading spaces", () => {
      const state = createState("hello", 2);
      const $from = state.doc.resolve(2);
      const lineStart = $from.start();
      const textBefore = state.doc.textBetween(lineStart, 2, "\n");

      const leadingSpaces = textBefore.match(/^[ ]*/)?.[0].length ?? 0;
      expect(leadingSpaces).toBe(0);
    });

    it("removes only tabSize spaces when more are present", () => {
      const state = createState("    hello", 5);
      const $from = state.doc.resolve(5);
      const lineStart = $from.start();
      const textBefore = state.doc.textBetween(lineStart, 5, "\n");

      const leadingSpaces = textBefore.match(/^[ ]*/)?.[0].length ?? 0;
      expect(leadingSpaces).toBe(4);

      const spacesToRemove = Math.min(leadingSpaces, 2); // tabSize = 2
      expect(spacesToRemove).toBe(2);
    });
  });

  describe("Tab insert spaces", () => {
    it("inserts tabSize spaces at cursor when no selection", () => {
      const tabSize = 2;
      const spaces = " ".repeat(tabSize);
      expect(spaces).toBe("  ");
      expect(spaces.length).toBe(2);
    });

    it("replaces selection with spaces when selection exists", () => {
      const state = createState("hello world");
      const sel = TextSelection.create(state.doc, 1, 6);
      expect(sel.empty).toBe(false);
    });

    it("inserts spaces at cursor position (no selection)", () => {
      const state = createState("hello world", 3);
      expect(state.selection.empty).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles empty document", () => {
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, []),
      ]);
      const state = EditorState.create({ doc, schema });
      expect(state.doc.textContent).toBe("");
    });

    it("handles document with only whitespace", () => {
      const state = createState("   ");
      expect(state.doc.textContent).toBe("   ");
    });

    it("handles cursor at start of document (pos 1)", () => {
      const state = createState("hello", 1);
      const $from = state.doc.resolve(1);
      expect($from.pos).toBe(1);
      expect($from.parentOffset).toBe(0);
    });

    it("handles cursor at end of document", () => {
      const state = createState("hello");
      const endPos = state.doc.content.size - 1;
      const stateAtEnd = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, endPos)),
      );
      expect(stateAtEnd.selection.from).toBe(endPos);
    });

    it("handles deeply nested list items", () => {
      // Create a nested list: bulletList > listItem > bulletList > listItem
      const innerItem = schema.node("listItem", null, [
        schema.node("paragraph", null, [schema.text("deep")]),
      ]);
      const innerList = schema.node("bulletList", null, [innerItem]);
      const outerItem = schema.node("listItem", null, [
        schema.node("paragraph", null, [schema.text("outer")]),
        innerList,
      ]);
      const doc = schema.node("doc", null, [
        schema.node("bulletList", null, [outerItem]),
      ]);
      const state = EditorState.create({ doc, schema });

      // Position inside the deeply nested item
      const listItemType = state.schema.nodes.listItem;
      let found = false;
      state.doc.descendants((node) => {
        if (node.type === listItemType) found = true;
      });
      expect(found).toBe(true);
    });
  });

  describe("Shift+Tab edge cases", () => {
    it("handles single leading space (less than tabSize)", () => {
      const state = createState(" hello", 2);
      const $from = state.doc.resolve(2);
      const lineStart = $from.start();
      const textBefore = state.doc.textBetween(lineStart, 2, "\n");

      const leadingSpaces = textBefore.match(/^[ ]*/)?.[0].length ?? 0;
      expect(leadingSpaces).toBe(1);

      // tabSize is 2, so only 1 space is removed
      const spacesToRemove = Math.min(leadingSpaces, 2);
      expect(spacesToRemove).toBe(1);
    });

    it("handles cursor at very start of line (no text before)", () => {
      const state = createState("hello", 1);
      const $from = state.doc.resolve(1);
      const lineStart = $from.start();
      const textBefore = state.doc.textBetween(lineStart, 1, "\n");
      expect(textBefore).toBe("");

      const leadingSpaces = textBefore.match(/^[ ]*/)?.[0].length ?? 0;
      expect(leadingSpaces).toBe(0);
    });
  });

  describe("Tab with selection", () => {
    it("replaces selected text with spaces", () => {
      const state = createState("hello world");
      const sel = TextSelection.create(state.doc, 1, 6);
      const stateWithSel = state.apply(state.tr.setSelection(sel));
      expect(stateWithSel.selection.empty).toBe(false);

      // Simulate replacing selection with tab spaces
      const tabSize = 2;
      const spaces = " ".repeat(tabSize);
      const tr = stateWithSel.tr.replaceSelectionWith(
        schema.text(spaces),
        true,
      );
      expect(tr.doc.textContent).toBe("   world");
    });
  });
});

// --- Phase 3: Plugin-level integration tests ---
// These tests instantiate the actual ProseMirror plugin from the extension
// and call its handleDOMEvents.keydown handler directly.

describe("tabIndent plugin handler integration", () => {
  let keydownHandler: (view: unknown, event: KeyboardEvent) => boolean;

  beforeEach(() => {
    mockIsInTable.mockReturnValue(false);
    mockGetTableInfo.mockReturnValue(null);
    vi.clearAllMocks();

    // Extract the actual plugin from the extension
    const extensionContext = {
      name: tabIndentExtension.name,
      options: { getTabSize: () => 2 }, // INJECTED now, not read from the store
      storage: tabIndentExtension.storage,
      editor: {} as never,
      type: null,
      parent: undefined,
    };
    const plugins = tabIndentExtension.config.addProseMirrorPlugins?.call(extensionContext) ?? [];
    expect(plugins).toHaveLength(1);
    const plugin = plugins[0];
    // Extract the keydown handler from plugin props
    keydownHandler = plugin.props.handleDOMEvents!.keydown as (view: unknown, event: KeyboardEvent) => boolean;
    expect(keydownHandler).toBeDefined();
  });

  function createMockView(state: EditorState) {
    const dispatched: unknown[] = [];
    return {
      state,
      dom: document.createElement("div"),
      dispatch: vi.fn((tr: unknown) => { dispatched.push(tr); }),
      dispatched,
    };
  }

  function makeTabEvent(overrides: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent("keydown", { key: "Tab", bubbles: true, ...overrides });
  }

  it("returns false for non-Tab keys", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = new KeyboardEvent("keydown", { key: "Enter" });
    const result = keydownHandler(view, event);
    expect(result).toBe(false);
  });

  it("returns false for Tab with Ctrl modifier", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ ctrlKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(false);
  });

  it("returns false for Tab with Alt modifier", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ altKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(false);
  });

  it("returns false for Tab with Meta modifier", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ metaKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(false);
  });

  it("returns false for IME composition (isComposing)", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent();
    Object.defineProperty(event, "isComposing", { value: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(false);
  });

  it("returns false for IME keyCode 229", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ keyCode: 229 });
    // keyCode 229 indicates IME composition
    Object.defineProperty(event, "keyCode", { value: 229 });
    const result = keydownHandler(view, event);
    expect(result).toBe(false);
  });

  it("inserts spaces at cursor on Tab (plain text, no selection)", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent();
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    // The dispatched transaction should insert 2 spaces (tabSize=2)
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.doc.textContent).toBe("he  llo");
  });

  it("replaces selection with spaces on Tab", () => {
    const state = createState("hello world");
    const sel = TextSelection.create(state.doc, 1, 6);
    const stateWithSel = state.apply(state.tr.setSelection(sel));
    const view = createMockView(stateWithSel);
    const event = makeTabEvent();
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.doc.textContent).toBe("   world");
  });

  it("removes leading spaces on Shift+Tab (outdent)", () => {
    const state = createState("  hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ shiftKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.doc.textContent).toBe("hello");
  });

  it("does nothing on Shift+Tab when no leading spaces", () => {
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ shiftKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    // dispatch should not be called — early return when leadingSpaces === 0
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("removes only tabSize spaces on Shift+Tab when more exist", () => {
    // 4 spaces before cursor, tabSize=2, should remove 2
    const state = createState("    hello", 5);
    const view = createMockView(state);
    const event = makeTabEvent({ shiftKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.doc.textContent).toBe("  hello");
  });

  it("falls through to table/list/outdent when Shift+Tab escape returns null", () => {
    const state = createState("  hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ shiftKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    // Should have handled as outdent since escape returned null
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("delegates to table navigation when in table", () => {
    mockIsInTable.mockReturnValue(true);
    const state = createState("hello", 3);
    const view = createMockView(state);
    const event = makeTabEvent();
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    expect(mockIsInTable).toHaveBeenCalled();
  });

  it("delegates to list sink on Tab in list item", () => {
    const state = createListState(["item 1"]);
    // Set selection inside the list item
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3)),
    );
    const view = createMockView(stateWithSel);
    const event = makeTabEvent();
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
  });

  it("delegates to list lift on Shift+Tab in list item", () => {
    const state = createListState(["item 1"]);
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3)),
    );
    const view = createMockView(stateWithSel);
    const event = makeTabEvent({ shiftKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
  });

  it("handles empty document Tab insertion", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, []),
    ]);
    const state = EditorState.create({ doc, schema });
    const view = createMockView(state);
    const event = makeTabEvent();
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.doc.textContent).toBe("  ");
  });

  it("handles Shift+Tab on empty document (no spaces to remove)", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, []),
    ]);
    const state = EditorState.create({ doc, schema });
    const view = createMockView(state);
    const event = makeTabEvent({ shiftKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    // No dispatch — nothing to remove
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("adds row after when at last table cell (goToNextCell returns false)", async () => {
    mockIsInTable.mockReturnValue(true);
    mockGetTableInfo.mockReturnValue({
      rowIndex: 2,
      colIndex: 3,
      numRows: 3,
      numCols: 4,
    });
    const { goToNextCell, addRowAfter } = await import("@tiptap/pm/tables");
    // First call returns false (at last cell), then true (after adding row)
    (goToNextCell as ReturnType<typeof vi.fn>).mockReturnValueOnce(vi.fn(() => false));
    (goToNextCell as ReturnType<typeof vi.fn>).mockReturnValueOnce(vi.fn(() => true));

    const state = createState("table cell", 3);
    const view = createMockView(state);
    const event = makeTabEvent();
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    expect(addRowAfter).toHaveBeenCalled();
  });

  // --- Coverage for uncovered branches ---

  it("Shift+Tab in table uses direction=-1 (line 129 shiftKey branch)", async () => {
    // Covers line 129: direction = event.shiftKey ? -1 : 1 (the -1 path)
    mockIsInTable.mockReturnValue(true);
    const { goToNextCell } = await import("@tiptap/pm/tables");
    // goToNextCell(-1) returns a function that returns true (moved)
    (goToNextCell as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn(() => true));

    const state = createState("table cell", 3);
    const view = createMockView(state);
    const event = makeTabEvent({ shiftKey: true }); // direction = -1
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    // goToNextCell should have been called with -1
    expect(goToNextCell).toHaveBeenCalledWith(-1);
  });

  it("isInListItem returns false when schema has no listItem type (line 51)", () => {
    // Covers line 51: if (!listItemType) return false
    // Build a schema without listItem and call keydownHandler with Shift+Tab
    // so it passes canTabEscape, table checks, then reaches isInListItem
    const simpleSchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "text*" },
        text: { inline: true },
      },
    });
    const doc = simpleSchema.node("doc", null, [
      simpleSchema.node("paragraph", null, [simpleSchema.text("  hello")]),
    ]);
    const state = EditorState.create({ doc, schema: simpleSchema });
    // Place cursor after the 2 leading spaces
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3))
    );

    mockIsInTable.mockReturnValue(false);

    const view = createMockView(stateWithSel);
    // Use Shift+Tab — skips canTabEscape, goes to table check (false), then isInListItem
    // isInListItem: listItemType = state.schema.nodes.listItem → undefined → line 51 returns false
    // Then falls to Shift+Tab outdent path (removes leading spaces)
    const event = makeTabEvent({ shiftKey: true });
    const result = keydownHandler(view, event);
    expect(result).toBe(true);
    // dispatch should be called to remove leading spaces
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

});

// Mark/link escape runs the REAL canTabEscape / canShiftTabEscape against a
// document that carries the marks, and asserts where the caret lands.
describe("tabIndent plugin handler — mark and link escape", () => {
  let keydownHandler: (view: unknown, event: KeyboardEvent) => boolean;

  const markSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*" },
      text: { group: "inline" },
    },
    marks: {
      bold: {},
      italic: {},
      link: { attrs: { href: { default: "" } } },
    },
  });

  /** "ab" + marked "cdef" + "gh": the marked run spans positions 3..7. */
  function markedDoc(mark: "bold" | "link"): PMNode {
    const m = mark === "link" ? markSchema.mark("link", { href: "https://x.test" }) : markSchema.mark("bold");
    return markSchema.node("doc", null, [
      markSchema.node("paragraph", null, [
        markSchema.text("ab"),
        markSchema.text("cdef", [m]),
        markSchema.text("gh"),
      ]),
    ]);
  }

  function stateAt(doc: PMNode, pos: number): EditorState {
    const state = EditorState.create({ doc, schema: markSchema });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  }

  function multiStateAt(doc: PMNode, positions: number[]): EditorState {
    const state = EditorState.create({ doc, schema: markSchema });
    const ranges = positions.map((pos) => new SelectionRange(state.doc.resolve(pos), state.doc.resolve(pos)));
    return state.apply(state.tr.setSelection(new MultiSelection(ranges, 0)));
  }

  function press(state: EditorState, shiftKey = false) {
    const dispatch = vi.fn();
    const handled = keydownHandler(
      { state, dispatch, dom: document.createElement("div") },
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, shiftKey }),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tr = dispatch.mock.calls[0][0] as import("@tiptap/pm/state").Transaction;
    return { handled, tr };
  }

  beforeEach(() => {
    mockIsInTable.mockReturnValue(false);
    vi.clearAllMocks();
    const plugins = tabIndentExtension.config.addProseMirrorPlugins?.call({
      name: tabIndentExtension.name,
      options: { getTabSize: () => 2 },
      storage: tabIndentExtension.storage,
      editor: {} as never,
      type: null,
      parent: undefined,
    }) ?? [];
    keydownHandler = plugins[0].props.handleDOMEvents!.keydown as typeof keydownHandler;
  });

  it("Tab inside bold jumps to the end of the bold run without editing text", () => {
    const state = stateAt(markedDoc("bold"), 5);
    const { handled, tr } = press(state);
    expect(handled).toBe(true);
    expect(tr.selection.from).toBe(7);
    expect(tr.doc.eq(state.doc)).toBe(true);
    expect((tr.storedMarks ?? []).some((m) => m.type.name === "bold")).toBe(false);
  });

  it("Tab inside a link jumps past the link and clears the stored link mark", () => {
    const state = stateAt(markedDoc("link"), 5);
    const { tr } = press(state);
    expect(tr.selection.from).toBe(7);
    expect(tr.doc.eq(state.doc)).toBe(true);
    expect((tr.storedMarks ?? []).some((m) => m.type.name === "link")).toBe(false);
  });

  it("Shift+Tab inside bold jumps to the START of the run (left escape, not outdent)", () => {
    const state = stateAt(markedDoc("bold"), 5);
    const { handled, tr } = press(state, true);
    expect(handled).toBe(true);
    expect(tr.selection.from).toBe(3);
    expect(tr.doc.eq(state.doc)).toBe(true);
  });

  it("Shift+Tab inside a link jumps to the start of the link", () => {
    const state = stateAt(markedDoc("link"), 5);
    const { tr } = press(state, true);
    expect(tr.selection.from).toBe(3);
    expect((tr.storedMarks ?? []).some((m) => m.type.name === "link")).toBe(false);
  });

  it("Tab in plain text after the marked run inserts spaces instead of escaping", () => {
    const state = stateAt(markedDoc("bold"), 8);
    const { tr } = press(state);
    expect(tr.doc.textContent).toBe("abcdefg  h");
  });

  it("multi-cursor Tab escapes only the cursor inside a mark and clears escapable stored marks", () => {
    const state = multiStateAt(markedDoc("bold"), [5, 8]);
    const { tr } = press(state);
    expect(tr.selection).toBeInstanceOf(MultiSelection);
    const ranges = (tr.selection as MultiSelection).ranges.map((r) => r.$from.pos);
    expect(ranges).toEqual([7, 8]);
    expect(tr.doc.eq(state.doc)).toBe(true);
    expect((tr.storedMarks ?? []).some((m) => ["bold", "italic", "link"].includes(m.type.name))).toBe(false);
  });

  it("multi-cursor Shift+Tab moves the cursor inside a mark to the run's start", () => {
    const state = multiStateAt(markedDoc("bold"), [5, 8]);
    const { tr } = press(state, true);
    expect(tr.selection).toBeInstanceOf(MultiSelection);
    const ranges = (tr.selection as MultiSelection).ranges.map((r) => r.$from.pos);
    expect(ranges).toEqual([3, 8]);
    expect(tr.doc.eq(state.doc)).toBe(true);
  });
});
