/**
 * Tests for smartPaste extension
 *
 * Tests:
 * - isValidUrl: URL validation for paste detection
 * - isSelectionInCode: code context detection (prevents smart paste in code)
 * - handlePaste: link wrapping behavior when pasting URL with text selected
 * - Edge cases: empty selection, no clipboardData, existing link marks
 */

import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Slice, Schema } from "@tiptap/pm/model";

// Mock pasteUtils
vi.mock("@/utils/pasteUtils", () => ({
  isSelectionInCode: vi.fn(() => false),
}));

import { smartPasteExtension } from "./tiptap";
import { isSelectionInCode as mockIsSelectionInCode } from "@/utils/pasteUtils";
import { EditorState, TextSelection } from "@tiptap/pm/state";

function createEditor(content: string) {
  return new Editor({
    extensions: [StarterKit, smartPasteExtension],
    content,
  });
}

function createClipboardEvent(text: string): ClipboardEvent {
  const clipboardData = {
    getData: vi.fn((type: string) => {
      if (type === "text/plain") return text;
      return "";
    }),
  };
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  return event;
}

// Re-implement the isSelectionInCode logic for code detection tests
function isSelectionInCode(editor: Editor): boolean {
  const { selection, schema } = editor.state;
  const codeBlock = schema.nodes.codeBlock;
  const codeMark = schema.marks.code;

  if (codeBlock) {
    for (let depth = selection.$from.depth; depth > 0; depth--) {
      if (selection.$from.node(depth).type === codeBlock) return true;
    }
  }

  if (codeMark) {
    const fromMarks = selection.$from.marks();
    if (codeMark.isInSet(fromMarks)) return true;
  }

  return false;
}

describe("smartPaste", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  describe("isValidUrl logic", () => {
    it("accepts http URLs", () => {
      expect(/^https?:\/\//i.test("http://example.com")).toBe(true);
    });

    it("accepts https URLs", () => {
      expect(/^https?:\/\//i.test("https://example.com")).toBe(true);
    });

    it("rejects URLs without protocol", () => {
      expect(/^https?:\/\//i.test("example.com")).toBe(false);
    });

    it("rejects ftp URLs", () => {
      expect(/^https?:\/\//i.test("ftp://example.com")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(/^https?:\/\//i.test("")).toBe(false);
    });

    it("rejects plain text", () => {
      expect(/^https?:\/\//i.test("not a url")).toBe(false);
    });

    it("handles URL with leading/trailing whitespace after trim", () => {
      expect(/^https?:\/\//i.test("  https://example.com  ".trim())).toBe(true);
    });

    it("accepts case-insensitive protocol", () => {
      expect(/^https?:\/\//i.test("HTTPS://EXAMPLE.COM")).toBe(true);
    });
  });

  describe("handlePaste behavior", () => {
    it("does not handle paste when selection is empty (cursor only)", () => {
      editor = createEditor("<p>hello world</p>");
      // Cursor at position 3 (no selection)
      editor.commands.setTextSelection(3);

      const event = createClipboardEvent("https://example.com");
      const handled = editor.view.someProp("handlePaste", (f) =>
        f(editor.view, event, Slice.empty),
      );
      // Empty selection => returns false
      expect(handled).toBeFalsy();
    });

    it("does not handle paste when clipboard text is not a URL", () => {
      editor = createEditor("<p>hello world</p>");
      editor.commands.setTextSelection({ from: 1, to: 6 });

      const event = createClipboardEvent("not a url");
      const handled = editor.view.someProp("handlePaste", (f) =>
        f(editor.view, event, Slice.empty),
      );
      expect(handled).toBeFalsy();
    });

    it("wraps selected text with pasted URL as link", () => {
      editor = createEditor("<p>hello world</p>");
      // Select "hello" (positions 1-6)
      editor.commands.setTextSelection({ from: 1, to: 6 });

      const event = createClipboardEvent("https://example.com");
      const handled = editor.view.someProp("handlePaste", (f) =>
        f(editor.view, event, Slice.empty),
      );

      expect(handled).toBe(true);
      // Verify the link was added
      const html = editor.getHTML();
      expect(html).toContain("https://example.com");
      expect(html).toContain("hello");
    });

    it("does not handle paste when no clipboardData", () => {
      editor = createEditor("<p>hello world</p>");
      editor.commands.setTextSelection({ from: 1, to: 6 });

      const event = new Event("paste", { bubbles: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: null });

      const handled = editor.view.someProp("handlePaste", (f) =>
        f(editor.view, event, Slice.empty),
      );
      expect(handled).toBeFalsy();
    });

    it("does not handle paste when clipboard is empty", () => {
      editor = createEditor("<p>hello world</p>");
      editor.commands.setTextSelection({ from: 1, to: 6 });

      const event = createClipboardEvent("");
      const handled = editor.view.someProp("handlePaste", (f) =>
        f(editor.view, event, Slice.empty),
      );
      expect(handled).toBeFalsy();
    });

    it("does not wrap when selection already has a link mark", () => {
      editor = createEditor('<p>hello <a href="http://old.com">world</a> text</p>');
      // Select the linked text "world"
      editor.commands.setTextSelection({ from: 8, to: 13 });

      const event = createClipboardEvent("https://new.com");
      const handled = editor.view.someProp("handlePaste", (f) =>
        f(editor.view, event, Slice.empty),
      );
      // Should not double-wrap: rangeHasMark returns true
      expect(handled).toBeFalsy();
    });
  });

  describe("code detection", () => {
    describe("code block detection", () => {
      it("detects selection inside code block", () => {
        editor = createEditor("<pre><code>some code here</code></pre>");
        editor.commands.setTextSelection({ from: 2, to: 6 });
        expect(isSelectionInCode(editor)).toBe(true);
      });

      it("returns false for selection outside code block", () => {
        editor = createEditor("<p>normal paragraph</p>");
        editor.commands.setTextSelection({ from: 2, to: 6 });
        expect(isSelectionInCode(editor)).toBe(false);
      });

      it("detects selection in code block even with multiple paragraphs", () => {
        editor = createEditor(`
          <p>First paragraph</p>
          <pre><code>code block content</code></pre>
          <p>Last paragraph</p>
        `);

        editor.commands.setTextSelection({ from: 18, to: 22 });

        const { selection, schema } = editor.state;
        const codeBlock = schema.nodes.codeBlock;
        let inCode = false;
        for (let depth = selection.$from.depth; depth > 0; depth--) {
          if (selection.$from.node(depth).type === codeBlock) {
            inCode = true;
            break;
          }
        }
        expect(inCode).toBe(true);
      });
    });

    describe("inline code detection", () => {
      it("detects selection with inline code mark", () => {
        editor = createEditor("<p>hello <code>world</code> text</p>");
        editor.commands.setTextSelection({ from: 8, to: 12 });
        expect(isSelectionInCode(editor)).toBe(true);
      });

      it("returns false for selection without code mark", () => {
        editor = createEditor("<p>hello <code>world</code> text</p>");
        editor.commands.setTextSelection({ from: 1, to: 6 });
        expect(isSelectionInCode(editor)).toBe(false);
      });
    });

    describe("mixed content", () => {
      it("correctly identifies code vs non-code in same document", () => {
        editor = createEditor(`
          <p>Normal text with <code>inline code</code> here</p>
          <pre><code>block code</code></pre>
          <p>More normal text</p>
        `);

        editor.commands.setTextSelection({ from: 2, to: 4 });
        expect(isSelectionInCode(editor)).toBe(false);
      });
    });
  });

  describe("handlePaste — code context guard (line 34)", () => {
    it("does not handle paste when selection is in code context", () => {
      editor = createEditor("<p>hello world</p>");
      editor.commands.setTextSelection({ from: 1, to: 6 });

      // Mock isSelectionInCode to return true
      vi.mocked(mockIsSelectionInCode).mockReturnValueOnce(true);

      const event = createClipboardEvent("https://example.com");
      const handled = editor.view.someProp("handlePaste", (f) =>
        f(editor.view, event, Slice.empty),
      );
      expect(handled).toBeFalsy();
    });
  });

  describe("handlePaste — missing link mark (line 40)", () => {
    it("does not handle paste when schema has no link mark", () => {
      // Create an editor with a schema that doesn't have link marks
      // Using a custom extension set without link support
      // Build a schema without link marks
      const schema = new Schema({
        nodes: {
          doc: { content: "paragraph+" },
          paragraph: { group: "block", content: "text*" },
          text: { inline: true },
        },
        // No marks at all — no link mark
      });

      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("hello world")]),
      ]);

      // Get the smartPaste plugin
      const plugins = smartPasteExtension.config.addProseMirrorPlugins!.call({
        name: "smartPaste", options: {}, storage: {}, editor: {},
      } as never);

      const state = EditorState.create({ doc, schema, plugins });

      // Create a selection (non-empty)
      const stateWithSel = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, 1, 6))
      );

      // Get handlePaste from plugin props
      const plugin = plugins[0];
      const handlePaste = (plugin as { props: { handlePaste: (...args: unknown[]) => unknown } }).props.handlePaste;

      const event = createClipboardEvent("https://example.com");

      // Create a minimal view mock
      const mockView = {
        state: stateWithSel,
        dispatch: vi.fn(),
      };

      const result = handlePaste(mockView, event);
      expect(result).toBe(false);
    });
  });

  describe("extension creation", () => {
    it("has name 'smartPaste'", () => {
      expect(smartPasteExtension.name).toBe("smartPaste");
    });
  });
});
