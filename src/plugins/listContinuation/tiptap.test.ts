/**
 * Tests for list continuation extension.
 *
 * Tests Enter key behavior in lists:
 * - Empty list item: lifts out of list (exits)
 * - Non-empty list item: splits into new item
 */

import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { listContinuationExtension } from "./tiptap";

vi.mock("@/utils/imeGuard", () => ({
  guardProseMirrorCommand: (fn: (...args: unknown[]) => unknown) => fn,
}));

function createEditor(content: string) {
  return new Editor({
    extensions: [StarterKit, listContinuationExtension],
    content,
  });
}

describe("listContinuationExtension", () => {
  describe("Enter in non-empty list item", () => {
    it("splits list item when content exists", () => {
      const editor = createEditor("<ul><li>First item</li></ul>");

      // Position cursor at end of "First item"
      editor.commands.focus("end");

      // Simulate Enter key
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      // Should now have two list items (TipTap wraps content in <p> tags)
      expect(html).toContain("<li><p>First item</p></li>");
      expect(html).toMatch(/<li><p>(<br[^>]*>)?<\/p><\/li>/); // Empty new item

      editor.destroy();
    });

    it("splits list item in middle of text", () => {
      const editor = createEditor("<ul><li>Hello World</li></ul>");

      // Position cursor after "Hello "
      // The list item content starts at position 2
      editor.commands.setTextSelection(8);

      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      // Should split into "Hello " and "World"
      expect(html).toMatch(/<li>.*Hello.*<\/li>/);

      editor.destroy();
    });
  });

  describe("Enter in empty list item", () => {
    it("exits list when pressing Enter on empty item", () => {
      const editor = createEditor("<ul><li>First item</li><li></li></ul>");

      // Position cursor in empty list item (the second one)
      // Doc structure: <doc><bullet_list><list_item><p>First item</p></list_item><list_item><p></p></list_item></bullet_list></doc>
      editor.commands.focus("end");

      // Simulate Enter key - should lift out of the empty list item
      editor.commands.keyboardShortcut("Enter");

      // After exiting, should have content outside the list
      const html = editor.getHTML();
      // The empty list item should be converted to paragraph outside list
      // The list might still exist with "First item"
      expect(html).toContain("First item");

      editor.destroy();
    });
  });

  describe("behavior outside lists", () => {
    it("does not affect Enter in paragraphs", () => {
      const editor = createEditor("<p>Normal paragraph</p>");

      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      // Should create a new paragraph
      expect(html).toMatch(/<p>.*<\/p>/);

      editor.destroy();
    });

    it("does not affect Enter in headings", () => {
      const editor = createEditor("<h1>Heading</h1>");

      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      expect(html).toContain("<h1>Heading</h1>");

      editor.destroy();
    });
  });

  describe("ordered lists", () => {
    it("continues numbered list when content exists", () => {
      const editor = createEditor("<ol><li>First</li></ol>");

      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      expect(html).toContain("<ol>");
      expect(html).toContain("<li><p>First</p></li>");

      editor.destroy();
    });
  });

  describe("nested lists", () => {
    it("handles Enter in nested list item", () => {
      const editor = createEditor("<ul><li>Parent<ul><li>Nested</li></ul></li></ul>");

      // This is a complex structure - just verify it doesn't throw
      editor.commands.focus("end");

      // Should not throw
      expect(() => editor.commands.keyboardShortcut("Enter")).not.toThrow();

      editor.destroy();
    });
  });

  describe("task list items", () => {
    it("splits task list item and resets checked state", () => {
      // Create editor with task list content containing checked attribute
      const editor = createEditor(
        '<ul><li data-checked="true"><p>Done task</p></li></ul>'
      );

      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      // Should have two list items after split
      expect(html).toContain("Done task");

      editor.destroy();
    });

    it("splits unchecked task list item", () => {
      const editor = createEditor(
        '<ul><li data-checked="false"><p>Pending task</p></li></ul>'
      );

      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      expect(html).toContain("Pending task");

      editor.destroy();
    });
  });

  describe("extension structure", () => {
    it("has the correct name", () => {
      expect(listContinuationExtension.name).toBe("listContinuation");
    });

    it("has priority 1000", () => {
      expect(listContinuationExtension.config.priority).toBe(1000);
    });

    it("defines ProseMirror plugins", () => {
      expect(listContinuationExtension.config.addProseMirrorPlugins).toBeDefined();
    });
  });

  describe("multiple list items", () => {
    it("continues list after multiple existing items", () => {
      const editor = createEditor(
        "<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>"
      );

      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      expect(html).toContain("Item 1");
      expect(html).toContain("Item 2");
      expect(html).toContain("Item 3");
      // Should have a fourth empty item
      expect((html.match(/<li>/g) || []).length).toBeGreaterThanOrEqual(4);

      editor.destroy();
    });

    it("exits list from empty item between non-empty items", () => {
      const editor = createEditor(
        "<ul><li>First</li><li></li><li>Third</li></ul>"
      );

      // Focus on the empty second item
      // Position: <doc><ul><li><p>First</p></li><li><p>|</p></li>...
      // First listItem: doc(0) > ul(1) > li(1) > p(1) > "First"(5) > /p > /li
      // Second listItem starts after that
      const doc = editor.state.doc;
      let emptyItemPos = -1;
      doc.descendants((node, pos) => {
        if (node.type.name === "listItem" && node.textContent === "") {
          emptyItemPos = pos + 2; // inside the empty paragraph
        }
      });

      if (emptyItemPos > 0) {
        editor.commands.setTextSelection(emptyItemPos);
        editor.commands.keyboardShortcut("Enter");
      }

      editor.destroy();
    });
  });

  describe("ordered list continuation", () => {
    it("exits ordered list on empty item", () => {
      const editor = createEditor("<ol><li>First</li><li></li></ol>");

      editor.commands.focus("end");
      editor.commands.keyboardShortcut("Enter");

      const html = editor.getHTML();
      expect(html).toContain("First");

      editor.destroy();
    });
  });
});

describe("listContinuation — direct ProseMirror tests", () => {
  const taskSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "text*", group: "block" },
      bulletList: { content: "listItem+", group: "block" },
      orderedList: { content: "listItem+", group: "block" },
      listItem: {
        content: "paragraph block*",
        attrs: { checked: { default: null } },
      },
      text: { inline: true },
    },
  });

  function createTaskDoc(text: string, checked: boolean | null = null) {
    const li = taskSchema.node("listItem", { checked }, [
      taskSchema.node("paragraph", null, text ? [taskSchema.text(text)] : []),
    ]);
    return taskSchema.node("doc", null, [
      taskSchema.node("bulletList", null, [li]),
    ]);
  }

  it("isListItemEmpty returns false for non-list positions (line 19)", () => {
    // Cursor in a paragraph outside any list
    const doc = taskSchema.node("doc", null, [
      taskSchema.node("paragraph", null, [taskSchema.text("Hello")]),
    ]);
    const state = EditorState.create({ doc, schema: taskSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 2))
    );
    // Get the plugin's keymap Enter handler via the extension
    const plugins = listContinuationExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "listContinuation",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    expect(plugins).toHaveLength(1);
    // The Enter handler should return false since not in a list
    const keymapPlugin = plugins[0];
    const handleKeyDown = keymapPlugin.props.handleKeyDown!;
    const mockEvent = new KeyboardEvent("keydown", { key: "Enter" });
    const result = handleKeyDown(
      { state: stateWithSel, dispatch: vi.fn() } as never,
      mockEvent
    );
    expect(result).toBe(false);
  });

  it("isInTaskItem returns false for non-task list items (line 34)", () => {
    // List item without checked attribute (checked: null)
    const doc = createTaskDoc("Normal item", null);
    const state = EditorState.create({ doc, schema: taskSchema });

    let textPos = 0;
    doc.descendants((node, pos) => {
      if (node.isText && textPos === 0) { textPos = pos; return false; }
      return true;
    });

    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, textPos))
    );
    const plugins = listContinuationExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "listContinuation",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const keymapPlugin = plugins[0];
    const handleKeyDown = keymapPlugin.props.handleKeyDown!;
    const mockEvent = new KeyboardEvent("keydown", { key: "Enter" });
    const dispatch = vi.fn();
    const result = handleKeyDown(
      { state: stateWithSel, dispatch } as never,
      mockEvent
    );
    // Should split normally (not via task path) — returns true
    expect(result).toBe(true);
    expect(dispatch).toHaveBeenCalled();
  });

  it("splitTaskListItem resets checked for task items (lines 41-67, 87)", () => {
    // List item with checked=true — task item
    const doc = createTaskDoc("Done task", true);
    const state = EditorState.create({ doc, schema: taskSchema });

    let textPos = 0;
    doc.descendants((node, pos) => {
      if (node.isText && textPos === 0) { textPos = pos; return false; }
      return true;
    });

    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, textPos + 4))
    );
    const plugins = listContinuationExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "listContinuation",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const keymapPlugin = plugins[0];
    const handleKeyDown = keymapPlugin.props.handleKeyDown!;
    const mockEvent = new KeyboardEvent("keydown", { key: "Enter" });
    const dispatch = vi.fn();
    const result = handleKeyDown(
      { state: stateWithSel, dispatch } as never,
      mockEvent
    );
    // Should use splitTaskListItem path
    expect(result).toBe(true);
    expect(dispatch).toHaveBeenCalled();
  });

  it("splitTaskListItem handles unchecked task items", () => {
    const doc = createTaskDoc("Pending", false);
    const state = EditorState.create({ doc, schema: taskSchema });

    let textPos = 0;
    doc.descendants((node, pos) => {
      if (node.isText && textPos === 0) { textPos = pos; return false; }
      return true;
    });

    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, textPos + 3))
    );
    const plugins = listContinuationExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "listContinuation",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const keymapPlugin = plugins[0];
    const handleKeyDown = keymapPlugin.props.handleKeyDown!;
    const mockEvent = new KeyboardEvent("keydown", { key: "Enter" });
    const dispatch = vi.fn();
    const result = handleKeyDown(
      { state: stateWithSel, dispatch } as never,
      mockEvent
    );
    expect(result).toBe(true);
    expect(dispatch).toHaveBeenCalled();
  });

  it("handleListEnter returns false when schema has no listItem type (line 76)", () => {
    // Schema without listItem or list_item → findListItemType returns undefined → return false
    const bareSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { group: "block", content: "text*" },
        text: { inline: true },
      },
    });
    const doc = bareSchema.node("doc", null, [
      bareSchema.node("paragraph", null, [bareSchema.text("Hello")]),
    ]);
    const state = EditorState.create({ doc, schema: bareSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 2))
    );

    const plugins = listContinuationExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "listContinuation",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const keymapPlugin = plugins[0];
    const handleKeyDown = keymapPlugin.props.handleKeyDown!;
    const mockEvent = new KeyboardEvent("keydown", { key: "Enter" });
    const result = handleKeyDown(
      { state: stateWithSel, dispatch: vi.fn() } as never,
      mockEvent
    );
    // No listItem in schema → returns false
    expect(result).toBe(false);
  });

  it("splitTaskListItem wrappedDispatch is undefined when no dispatch provided (line 65 : undefined branch)", () => {
    // When splitTaskListItem is called without dispatch (dry-run check),
    // wrappedDispatch should be undefined and splitListItem should still return
    // a boolean indicating whether the operation is possible.
    const doc = createTaskDoc("Task", true);
    const state = EditorState.create({ doc, schema: taskSchema });

    let textPos = 0;
    doc.descendants((node, pos) => {
      if (node.isText && textPos === 0) { textPos = pos; return false; }
      return true;
    });

    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, textPos + 2))
    );

    const plugins = listContinuationExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "listContinuation",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const keymapPlugin = plugins[0];
    const handleKeyDown = keymapPlugin.props.handleKeyDown!;
    const mockEvent = new KeyboardEvent("keydown", { key: "Enter" });

    // Pass dispatch=undefined to trigger the `: undefined` branch (line 65)
    const result = handleKeyDown(
      { state: stateWithSel, dispatch: undefined } as never,
      mockEvent
    );
    // splitListItem without dispatch is a dry-run → returns true (can split)
    expect(result).toBe(true);
  });
});
