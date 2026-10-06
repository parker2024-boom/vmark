/**
 * listSmartIndent Tests
 *
 * Tests for Tab/Shift+Tab smart indentation of list items in source mode.
 */

import { describe, it, expect, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listSmartIndent, listSmartOutdent } from "../listSmartIndent";

// Mock settingsStore for getTabSize()
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      general: { tabSize: 2 },
    }),
  },
}));

function createView(content: string, cursorPos: number): EditorView {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
  });
  return new EditorView({
    state,
    parent: document.createElement("div"),
  });
}

function createViewWithMultiCursor(content: string, positions: number[]): EditorView {
  const ranges = positions.map((pos) => EditorSelection.cursor(pos));
  const state = EditorState.create({
    doc: content,
    selection: EditorSelection.create(ranges, 0),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  return new EditorView({
    state,
    parent: document.createElement("div"),
  });
}

describe("listSmartIndent", () => {
  it("returns false for multi-cursor state", () => {
    const content = "- item one\n- item two";
    const view = createViewWithMultiCursor(content, [5, 16]);
    const result = listSmartIndent(view);
    expect(result).toBe(false);
    view.destroy();
  });

  it("indents a list item", () => {
    const content = "- hello";
    const view = createView(content, 3);
    const result = listSmartIndent(view);
    expect(result).toBe(true);
    expect(view.state.doc.toString()).toBe("  - hello");
    view.destroy();
  });

  it("returns false for non-list line", () => {
    const content = "plain text";
    const view = createView(content, 3);
    const result = listSmartIndent(view);
    expect(result).toBe(false);
    view.destroy();
  });
});

describe("listSmartOutdent", () => {
  it("returns false for multi-cursor state", () => {
    const content = "  - item one\n  - item two";
    const view = createViewWithMultiCursor(content, [7, 20]);
    const result = listSmartOutdent(view);
    expect(result).toBe(false);
    view.destroy();
  });

  it("outdents a list item", () => {
    const content = "  - hello";
    const view = createView(content, 5);
    const result = listSmartOutdent(view);
    expect(result).toBe(true);
    expect(view.state.doc.toString()).toBe("- hello");
    view.destroy();
  });

  it("returns false for non-list line", () => {
    const content = "  plain text";
    const view = createView(content, 5);
    const result = listSmartOutdent(view);
    expect(result).toBe(false);
    view.destroy();
  });
});
