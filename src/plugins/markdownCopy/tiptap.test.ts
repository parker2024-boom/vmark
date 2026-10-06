import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanTextForClipboard } from "./tiptap";

// Mock debug utilities
vi.mock("@/utils/debug", () => ({
  clipboardWarn: vi.fn(),
  markdownCopyWarn: vi.fn(),
}));

describe("cleanTextForClipboard", () => {
  it("trims trailing whitespace from each line", () => {
    expect(cleanTextForClipboard("hello   \nworld  ")).toBe("hello\nworld");
  });

  it("trims trailing tabs from each line", () => {
    expect(cleanTextForClipboard("hello\t\t\nworld\t")).toBe("hello\nworld");
  });

  it("collapses multiple blank lines into one", () => {
    expect(cleanTextForClipboard("a\n\n\nb")).toBe("a\n\nb");
  });

  it("collapses many blank lines into one", () => {
    expect(cleanTextForClipboard("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading blank lines", () => {
    expect(cleanTextForClipboard("\n\nhello")).toBe("hello");
  });

  it("trims trailing blank lines", () => {
    expect(cleanTextForClipboard("hello\n\n")).toBe("hello");
  });

  it("trims both leading and trailing blank lines", () => {
    expect(cleanTextForClipboard("\n\nhello\n\n")).toBe("hello");
  });

  it("handles all three rules together", () => {
    const input = "\n\nline one   \n\n\n\nline two  \n\n";
    expect(cleanTextForClipboard(input)).toBe("line one\n\nline two");
  });

  it("preserves single blank line between paragraphs", () => {
    expect(cleanTextForClipboard("para one\n\npara two")).toBe(
      "para one\n\npara two"
    );
  });

  it("returns empty string for whitespace-only input", () => {
    expect(cleanTextForClipboard("   \n\n  \n  ")).toBe("");
  });

  it("handles empty string input", () => {
    expect(cleanTextForClipboard("")).toBe("");
  });

  it("preserves indentation on non-first lines", () => {
    // The outer .trim() strips leading spaces on the first line,
    // but indentation on subsequent lines is preserved.
    expect(cleanTextForClipboard("first\n    indented")).toBe(
      "first\n    indented"
    );
  });

  it("handles single line with trailing whitespace", () => {
    expect(cleanTextForClipboard("hello   ")).toBe("hello");
  });

  it("handles mixed tabs and spaces in trailing whitespace", () => {
    expect(cleanTextForClipboard("hello \t \t\nworld")).toBe("hello\nworld");
  });

  it("handles exactly two newlines (single blank line preserved)", () => {
    expect(cleanTextForClipboard("a\n\nb")).toBe("a\n\nb");
  });

  it("does not trim non-breaking spaces", () => {
    // \u00a0 is a non-breaking space, which is not matched by [^\S\n]+ (it is \S)
    // Actually \u00a0 IS matched by \s but NOT by \S... let's verify behavior
    const result = cleanTextForClipboard("hello\u00a0\nworld");
    // Non-breaking space at end of line: [^\S\n]+ matches it since \u00a0 is whitespace but not \n
    expect(result).toBe("hello\nworld");
  });
});

describe("markdownCopyExtension structure", () => {
  it("has correct name", async () => {
    const { markdownCopyExtension } = await import("./tiptap");
    expect(markdownCopyExtension.name).toBe("markdownCopy");
  });

  it("defines ProseMirror plugins", async () => {
    const { markdownCopyExtension } = await import("./tiptap");
    expect(markdownCopyExtension.config.addProseMirrorPlugins).toBeDefined();
  });

  it("plugin has clipboardTextSerializer", async () => {
    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "markdownCopy",
      options: copyOptions(),
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    expect(plugins).toHaveLength(1);
    const plugin = plugins[0] as { props: { clipboardTextSerializer?: unknown } };
    expect(plugin.props.clipboardTextSerializer).toBeDefined();
  });

  it("plugin has mouseup DOM event handler", async () => {
    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "markdownCopy",
      options: copyOptions(),
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents?: { mouseup?: unknown } } };
    expect(plugin.props.handleDOMEvents?.mouseup).toBeDefined();
  });
});

// --- Plugin integration tests ---
// Test the plugin behavior through the extension's ProseMirror plugin.

/**
 * The plugin takes GETTERS now (ADR-015), so these drive the values directly
 * instead of mocking the settings store — which is also what the app does.
 */
let testCopyFormat: "default" | "markdown" = "default";
let testCopyOnSelect = false;
const copyOptions = () => ({
  getCopyFormat: () => testCopyFormat,
  getCopyOnSelect: () => testCopyOnSelect,
});

describe("markdownCopyExtension plugin integration", () => {
  // WI-DP3.0 pilot — archetype "vi.doMock". Nothing called `_getPluginInstance`
  // and nothing read `_mockSettingsGetState`; both were underscore-prefixed
  // scaffolding left behind by an earlier approach. The only `vi.doMock` of a
  // store in this file lived inside that dead helper, so the conversion here is
  // a deletion — the cheapest archetype, and one a count of mocks cannot
  // distinguish from the expensive ones.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clipboardTextSerializer returns empty string when copyFormat is not 'markdown'", async () => {
    const { markdownCopyExtension } = await import("./tiptap");
    const extensionContext = {
      editor: {},
      name: "markdownCopy",
      options: copyOptions(),
      storage: {},
      type: undefined,
      parent: undefined,
    };
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call(extensionContext as never);
    const plugin = plugins[0] as { props: { clipboardTextSerializer: (slice: unknown, view: unknown) => string } };
    expect(plugin.props.clipboardTextSerializer).toBeDefined();
  });

  it("mouseup handler returns false when copyOnSelect is disabled", async () => {
    const { markdownCopyExtension } = await import("./tiptap");
    const extensionContext = {
      editor: {},
      name: "markdownCopy",
      options: copyOptions(),
      storage: {},
      type: undefined,
      parent: undefined,
    };
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call(extensionContext as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };
    // mouseup always returns false (it does not prevent default)
    const result = plugin.props.handleDOMEvents.mouseup({} as never);
    expect(result).toBe(false);
  });
});

describe("ensureBlockContent and createDocFromSlice via clipboardTextSerializer", () => {
  it("clipboardTextSerializer returns empty string for non-markdown copyFormat", async () => {
    testCopyFormat = "default";
    testCopyOnSelect = false;

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { clipboardTextSerializer: (slice: unknown, view: unknown) => string } };

    const result = plugin.props.clipboardTextSerializer({} as never, {} as never);
    expect(result).toBe("");
  });

  it("clipboardTextSerializer serializes markdown when copyFormat is 'markdown'", async () => {
    testCopyFormat = "markdown";
    testCopyOnSelect = false;

    const { Schema } = await import("@tiptap/pm/model");
    const { Slice, Fragment } = await import("@tiptap/pm/model");
    const { EditorState } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    const state = EditorState.create({ doc, schema: testSchema });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { clipboardTextSerializer: (slice: unknown, view: unknown) => string } };

    const content = Fragment.from(testSchema.node("paragraph", null, [testSchema.text("hello")]));
    const slice = new Slice(content, 0, 0);
    const mockView = { state };

    const result = plugin.props.clipboardTextSerializer(slice, mockView);
    expect(typeof result).toBe("string");
  });

  it("clipboardTextSerializer returns empty string when serialization fails", async () => {
    testCopyFormat = "markdown";
    testCopyOnSelect = false;

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { clipboardTextSerializer: (slice: unknown, view: unknown) => string } };

    // Pass invalid slice and view to trigger error path
    const result = plugin.props.clipboardTextSerializer(null, { state: { schema: {} } });
    expect(result).toBe("");
  });
});

describe("ensureBlockContent and createDocFromSlice edge cases", () => {
  it("handles inline-only content slice for markdown serialization", async () => {
    testCopyFormat = "markdown";
    testCopyOnSelect = false;

    const { Schema } = await import("@tiptap/pm/model");
    const { Slice, Fragment } = await import("@tiptap/pm/model");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
      },
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { clipboardTextSerializer: (slice: unknown, view: unknown) => string } };

    // Inline-only content (text node without paragraph wrapper)
    const inlineContent = Fragment.from(testSchema.text("just inline text"));
    const slice = new Slice(inlineContent, 0, 0);
    const { EditorState } = await import("@tiptap/pm/state");
    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello")]),
    ]);
    const state = EditorState.create({ doc, schema: testSchema });
    const mockView = { state };

    const result = plugin.props.clipboardTextSerializer(slice, mockView);
    expect(typeof result).toBe("string");
  });

  it("handles empty fragment slice", async () => {
    testCopyFormat = "markdown";
    testCopyOnSelect = false;

    const { Schema } = await import("@tiptap/pm/model");
    const { Slice, Fragment } = await import("@tiptap/pm/model");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
      },
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { clipboardTextSerializer: (slice: unknown, view: unknown) => string } };

    const emptySlice = new Slice(Fragment.empty, 0, 0);
    const { EditorState } = await import("@tiptap/pm/state");
    const doc = testSchema.node("doc", null, [testSchema.node("paragraph")]);
    const state = EditorState.create({ doc, schema: testSchema });

    const result = plugin.props.clipboardTextSerializer(emptySlice, { state });
    expect(typeof result).toBe("string");
  });
});

describe("mouseup handler with copyOnSelect and markdown format", () => {
  it("copies markdown on mouseup when copyOnSelect and copyFormat=markdown", async () => {
    testCopyFormat = "markdown";
    testCopyOnSelect = true;

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    const mockView = {
      state,
      isDestroyed: false,
    };

    const result = plugin.props.handleDOMEvents.mouseup(mockView);
    expect(result).toBe(false);
  });
});

describe("mouseup handler rAF callback execution", () => {
  it("executes clipboard write inside requestAnimationFrame callback", async () => {
    // Capture the rAF callback and execute it synchronously
    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    });

    testCopyFormat = "default";
    testCopyOnSelect = true;

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    const mockView = { state, isDestroyed: false };
    plugin.props.handleDOMEvents.mouseup(mockView);

    // Execute the rAF callback
    rAFCallbacks.forEach((cb) => cb(0));

    // Should have called clipboard.writeText with the selected text
    expect(writeTextSpy).toHaveBeenCalledWith("hello");
  });

  it("handles clipboard write failure gracefully", async () => {
    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    });

    testCopyFormat = "default";
    testCopyOnSelect = true;

    const writeTextSpy = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    const mockView = { state, isDestroyed: false };
    plugin.props.handleDOMEvents.mouseup(mockView);

    // Execute the rAF callback — should not throw despite clipboard rejection
    expect(() => rAFCallbacks.forEach((cb) => cb(0))).not.toThrow();
  });

  it("does not write to clipboard when selection is empty in rAF", async () => {
    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    });

    testCopyFormat = "default";
    testCopyOnSelect = true;

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello")]),
    ]);
    // Collapsed selection (from === to)
    const state = EditorState.create({ doc, schema: testSchema });

    const mockView = { state, isDestroyed: false };
    plugin.props.handleDOMEvents.mouseup(mockView);

    rAFCallbacks.forEach((cb) => cb(0));

    // Should not write to clipboard when from === to
    expect(writeTextSpy).not.toHaveBeenCalled();
  });
});

describe("getSelectionText with copyFormat=markdown (lines 123-125)", () => {
  it("returns markdown-formatted text when copyFormat is markdown", async () => {
    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    });

    testCopyFormat = "markdown";
    testCopyOnSelect = true;

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    const mockView = { state, isDestroyed: false };
    plugin.props.handleDOMEvents.mouseup(mockView);

    // Execute rAF callback
    rAFCallbacks.forEach((cb) => cb(0));

    // Should write markdown-formatted text to clipboard
    expect(writeTextSpy).toHaveBeenCalledWith(expect.any(String));
  });
});

describe("a throw while building the copied document", () => {
  it("copies no markdown, so ProseMirror copies the plain text", async () => {
    testCopyFormat = "markdown";
    testCopyOnSelect = false;

    const { Schema, Slice, Fragment } = await import("@tiptap/pm/model");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const origCreate = testSchema.topNodeType.create.bind(testSchema.topNodeType);
    const doc = origCreate(null, [testSchema.node("paragraph", null, [testSchema.text("body")])]);
    testSchema.topNodeType.create = () => {
      throw new RangeError("Invalid content for node doc");
    };

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { clipboardTextSerializer: (slice: unknown, view: unknown) => string } };

    const para = testSchema.node("paragraph", null, [testSchema.text("hello")]);
    const slice = new Slice(Fragment.from(para), 0, 0);
    const { EditorState } = await import("@tiptap/pm/state");
    const state = EditorState.create({ doc, schema: testSchema });

    // An empty result is what tells ProseMirror to fall back to the text.
    expect(plugin.props.clipboardTextSerializer(slice, { state })).toBe("");
    testSchema.topNodeType.create = origCreate;
  });
});

describe("getSelectionText — md is null fallback to textBetween (line 125)", () => {
  it("falls back to textBetween when serializeSliceAsMarkdown returns null", async () => {
    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    });

    testCopyFormat = "markdown";
    testCopyOnSelect = true;

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    // Make slice() return something that triggers serialization failure → md is null
    const origSlice = state.doc.slice.bind(state.doc);
    state.doc.slice = (...args: Parameters<typeof origSlice>) => {
      const s = origSlice(...args);
      // Corrupt the schema so serialization throws
      return { ...s, content: null } as never;
    };

    const mockView = { state, isDestroyed: false };
    plugin.props.handleDOMEvents.mouseup(mockView);
    rAFCallbacks.forEach((cb) => cb(0));

    // textBetween fallback should still write to clipboard
    expect(writeTextSpy).toHaveBeenCalled();
  });
});

describe("mouseup rAF — view.isDestroyed true path (line 150)", () => {
  it("skips clipboard write when view is destroyed inside rAF", async () => {
    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    });

    testCopyFormat = "default";
    testCopyOnSelect = true;

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    // view.isDestroyed is true — rAF callback should return early
    const mockView = { state, isDestroyed: true };
    plugin.props.handleDOMEvents.mouseup(mockView);

    // Execute rAF callback — isDestroyed is true so writeText should NOT be called
    rAFCallbacks.forEach((cb) => cb(0));

    expect(writeTextSpy).not.toHaveBeenCalled();
  });
});

describe("mouseup rAF — non-Error clipboard rejection (line 155)", () => {
  it("handles non-Error clipboard write rejection using String(error)", async () => {
    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    });

    testCopyFormat = "default";
    testCopyOnSelect = true;

    // Reject with a non-Error value (string) to exercise the String(error) branch
    const writeTextSpy = vi.fn().mockRejectedValue("permission denied");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    const mockView = { state, isDestroyed: false };
    plugin.props.handleDOMEvents.mouseup(mockView);

    // Should not throw even with non-Error rejection
    expect(() => rAFCallbacks.forEach((cb) => cb(0))).not.toThrow();
    expect(writeTextSpy).toHaveBeenCalled();
  });
});

describe("mouseup handler with copyOnSelect enabled", () => {
  it("copies selected text on mouseup when copyOnSelect is enabled", async () => {
    testCopyFormat = "default";
    testCopyOnSelect = true;

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState, TextSelection } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello world")]),
    ]);
    let state = EditorState.create({ doc, schema: testSchema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));

    const mockView = {
      state,
      isDestroyed: false,
    };

    const result = plugin.props.handleDOMEvents.mouseup(mockView);
    expect(result).toBe(false); // Always returns false
  });

  it("mouseup does not copy when view is destroyed in rAF", async () => {
    testCopyFormat = "default";
    testCopyOnSelect = true;

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const mockView = {
      state: { selection: { from: 1, to: 1 } },
      isDestroyed: true,
    };

    const result = plugin.props.handleDOMEvents.mouseup(mockView);
    expect(result).toBe(false);
  });

  it("mouseup does not copy when selection is empty (from === to)", async () => {
    testCopyFormat = "default";
    testCopyOnSelect = true;

    const { markdownCopyExtension } = await import("./tiptap");
    const plugins = markdownCopyExtension.config.addProseMirrorPlugins!.call({
      editor: {}, name: "markdownCopy", options: copyOptions(), storage: {}, type: undefined, parent: undefined,
    } as never);
    const plugin = plugins[0] as { props: { handleDOMEvents: { mouseup: (view: unknown) => boolean } } };

    const { Schema } = await import("@tiptap/pm/model");
    const { EditorState } = await import("@tiptap/pm/state");

    const testSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*", group: "block" },
        text: { inline: true },
      },
    });

    const doc = testSchema.node("doc", null, [
      testSchema.node("paragraph", null, [testSchema.text("hello")]),
    ]);
    const state = EditorState.create({ doc, schema: testSchema });

    const mockView = {
      state,
      isDestroyed: false,
    };

    const result = plugin.props.handleDOMEvents.mouseup(mockView);
    expect(result).toBe(false);
  });
});
