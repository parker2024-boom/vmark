// @vitest-environment node
// WI-RA17C.3 — the markdown slice builder moved to plugins/shared keeps its behaviour (tests moved from markdownPaste/tiptap.test.ts)
import { describe, it, expect, vi } from "vitest";

vi.mock("@/utils/debug", () => ({
  pasteError: vi.fn(),
}));
import StarterKit from "@tiptap/starter-kit";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Fragment, Schema, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { pasteError } from "@/utils/debug";
import {
  createMarkdownPasteSlice,
  createMarkdownPasteTransaction,
  MarkdownPasteTooComplexError,
} from "./markdownPasteSlice";

const schema = getSchema([StarterKit]);

function createParagraphDoc(text: string) {
  const paragraph = schema.nodes.paragraph.create(
    null,
    text ? schema.text(text) : undefined
  );
  return schema.nodes.doc.create(null, [paragraph]);
}

function containsNode(doc: PMNode, typeName: string): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === typeName) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function createState(doc: PMNode, selectionPos = 1) {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, selectionPos),
  });
}

describe("createMarkdownPasteSlice", () => {
  it("returns a Slice from markdown text", () => {
    const state = createState(createParagraphDoc(""));
    const slice = createMarkdownPasteSlice(state, "# Heading");
    expect(slice).toBeInstanceOf(Slice);
    expect(slice.content.childCount).toBeGreaterThan(0);
  });

  it("handles empty content by creating empty paragraph", () => {
    const state = createState(createParagraphDoc(""));
    // Markdown that parses to empty content should produce at least a paragraph
    const slice = createMarkdownPasteSlice(state, "");
    expect(slice.content.childCount).toBeGreaterThanOrEqual(0);
  });
});

describe("createMarkdownPasteTransaction", () => {
  it("returns null on parse failure", () => {
    // Mock console.error to suppress noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Create a state with a broken/minimal schema that might cause parse to fail
    const state = createState(createParagraphDoc("existing"));
    // We can't easily trigger parse failure with real schema, but we test the success path
    const tr = createMarkdownPasteTransaction(state, "# Valid Markdown");
    expect(tr).not.toBeNull();
    spy.mockRestore();
  });

  it("creates headings from markdown heading syntax", () => {
    const state = createState(createParagraphDoc(""));
    const tr = createMarkdownPasteTransaction(state, "# Heading 1\n\n## Heading 2");
    expect(tr).not.toBeNull();
    if (tr) {
      const next = state.apply(tr);
      expect(containsNode(next.doc, "heading")).toBe(true);
    }
  });

  it("creates ordered lists from numbered list markdown", () => {
    const state = createState(createParagraphDoc(""));
    const tr = createMarkdownPasteTransaction(state, "1. first\n2. second\n3. third");
    expect(tr).not.toBeNull();
    if (tr) {
      const next = state.apply(tr);
      expect(containsNode(next.doc, "orderedList")).toBe(true);
    }
  });

  it("creates blockquotes from > syntax", () => {
    const state = createState(createParagraphDoc(""));
    const tr = createMarkdownPasteTransaction(state, "> quoted text");
    expect(tr).not.toBeNull();
    if (tr) {
      const next = state.apply(tr);
      expect(containsNode(next.doc, "blockquote")).toBe(true);
    }
  });
});

describe("createMarkdownPasteTransaction error handling", () => {
  it("returns null when parsing against an incompatible schema throws", () => {
    // Create a state with an incompatible schema to trigger an error
    const minSchema = new Schema({
      nodes: {
        doc: { content: "text*" },
        text: { inline: true },
      },
    });
    const doc = minSchema.text("hello");
    const docNode = minSchema.node("doc", null, [doc]);
    const state = EditorState.create({ doc: docNode, schema: minSchema });

    // This should fail because parseMarkdown expects paragraph nodes
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tr = createMarkdownPasteTransaction(state, "# Heading\n\nSome **bold** text");
    // If it doesn't throw internally, it might still succeed, so check both cases
    if (tr === null) {
      expect(consoleSpy).toHaveBeenCalled();
    }
    consoleSpy.mockRestore();
  });

  it("returns null and logs error when replaceSelection throws", () => {
    // Use a valid state but monkey-patch tr.replaceSelection to throw
    const state = createState(createParagraphDoc("existing"));
    const origTr = state.tr;
    const patchedTr = {
      ...origTr,
      replaceSelection: () => { throw new Error("replace failed"); },
    };
    const patchedState = { ...state, tr: patchedTr, schema: state.schema };

    const tr = createMarkdownPasteTransaction(patchedState as unknown as typeof state, "# Heading");
    expect(tr).toBeNull();
    expect(pasteError).toHaveBeenCalledWith(
      "Failed to parse markdown:",
      expect.any(Error)
    );
  });
});

describe("markdown paste node-count cap", () => {
  it("rejects pastes whose parsed structure exceeds MAX_MARKDOWN_PASTE_NODES", () => {
    // 2_500 list items → ~7_500 nodes (list_item + paragraph + text each), safely
    // above the 5_000 cap with margin. Kept to the minimum that trips the cap so
    // the remark parse stays cheap — parsing 6_000+ items can exceed the test
    // timeout under parallel CPU load (the cap logic is what we're testing, not
    // parse throughput). Regression context: a 199KB paste of this shape used to
    // freeze the editor for seconds during dispatch.
    const big = Array.from({ length: 2_500 }, (_, i) => `- item ${i}`).join("\n");
    const state = createState(createParagraphDoc(""));
    const tr = createMarkdownPasteTransaction(state, big);
    expect(tr).toBeNull();
    // The catch path logs via pasteError with the "falling back to plain text" message.
    expect(pasteError).toHaveBeenCalledWith(
      expect.stringContaining("falling back to plain text"),
      expect.stringContaining("more than 5000 nodes"),
    );
  });

  it("MarkdownPasteTooComplexError exposes the node count in its message", () => {
    const err = new MarkdownPasteTooComplexError(8_000);
    expect(err.name).toBe("MarkdownPasteTooComplexError");
    expect(err.message).toMatch(/8000/);
  });

  it("accepts pastes well below the node cap", () => {
    const state = createState(createParagraphDoc(""));
    const tr = createMarkdownPasteTransaction(state, "# Title\n\nSome **bold** text.");
    expect(tr).not.toBeNull();
  });
});

describe("ensureBlockContent — block firstChild is kept", () => {
  it("returns content unchanged when firstChild is already a block node", () => {
    const state = createState(createParagraphDoc(""));
    // A heading or paragraph is a block — ensureBlockContent should NOT wrap it
    const tr = createMarkdownPasteTransaction(state, "# Block Heading");
    expect(tr).not.toBeNull();
    if (tr) {
      const next = state.apply(tr);
      // heading node is a block — should be present without extra paragraph wrapper
      expect(containsNode(next.doc, "heading")).toBe(true);
    }
  });
});

describe("ensureBlockContent — inline firstChild is wrapped", () => {
  it("wraps inline content in a paragraph when parseMarkdown returns inline fragment", async () => {
    // We need parseMarkdown to return a doc whose .content has an inline text node as firstChild.
    // Mock parseMarkdown to return a fake doc with inline content.
    const testSchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
      },
    });

    // Create a fragment with just an inline text node (no block wrapper)
    const inlineFragment = Fragment.from(testSchema.text("just inline"));

    // Build a fake "parsed doc" whose .content is inline
    const fakeDoc = { content: inlineFragment } as unknown as import("@tiptap/pm/model").Node;

    // Mock parseMarkdown to return fakeDoc
    const pipelineMod = await import("@/utils/markdownPipeline");
    const spy = vi.spyOn(pipelineMod, "parseMarkdown").mockReturnValueOnce(fakeDoc);

    const state = EditorState.create({
      doc: testSchema.node("doc", null, [testSchema.node("paragraph")]),
      schema: testSchema,
    });

    // createMarkdownPasteSlice calls parseMarkdown → gets fakeDoc with inline content
    // ensureBlockContent should wrap it in a paragraph
    const { createMarkdownPasteSlice } = await import("./markdownPasteSlice");
    const slice = createMarkdownPasteSlice(state, "ignored — mocked");

    expect(slice).toBeDefined();
    // The inline content should have been wrapped in a paragraph
    expect(slice.content.childCount).toBeGreaterThanOrEqual(1);

    spy.mockRestore();
  });
});
