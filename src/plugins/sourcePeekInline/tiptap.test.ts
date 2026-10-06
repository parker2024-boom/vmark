/**
 * Tests for sourcePeekInline extension — extension structure, plugin state
 * init/apply, widget factory, live preview, and re-exports.
 *
 * The real header builder and the real CodeMirror peek editor run: the widget
 * is rendered, its buttons clicked, and its CodeMirror view edited and keyed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, Transaction } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { EditorView as CMEditorView, runScopeHandlers } from "@codemirror/view";

// Mock CSS
vi.mock("./source-peek-inline.css", () => ({}));

// Mock store
const mockStoreState = {
  isOpen: false,
  range: null as { from: number; to: number } | null,
  markdown: "",
  blockTypeName: null as string | null,
  hasUnsavedChanges: false,
  livePreview: false,
  toggleLivePreview: vi.fn(),
  setMarkdown: vi.fn(),
};
const mockSetState = vi.fn();
// The peek state is a PORT with a binder — bound below, not module-mocked.
const mockPeekStore = {
  getState: () => mockStoreState,
  setState: (...args: unknown[]) => mockSetState(...args),
} as never;

// Mock dependencies
const mockApplySourcePeekMarkdown = vi.fn();
const mockGetExpandedSourcePeekRange = vi.fn(() => ({ from: 0, to: 10 }));
import { bindSourcePeekStore } from "./peekStore";
bindSourcePeekStore(mockPeekStore);

vi.mock("@/services/editor/sourcePeek", () => ({
  applySourcePeekMarkdown: (...args: unknown[]) => mockApplySourcePeekMarkdown(...args),
  getExpandedSourcePeekRange: (...args: unknown[]) => mockGetExpandedSourcePeekRange(...args),
}));

const mockGetMarkdownOptions = vi.fn(() => ({}));
const mockCommitSourcePeek = vi.fn();
const mockRevertAndCloseSourcePeek = vi.fn();
vi.mock("./sourcePeekActions", () => ({
  EDITING_STATE_CHANGED: "sourcePeekEditingChanged",
  getMarkdownOptions: (...args: unknown[]) => mockGetMarkdownOptions(...args),
  canUseSourcePeek: vi.fn(() => true),
  openSourcePeekInline: vi.fn(),
  commitSourcePeek: (...args: unknown[]) => mockCommitSourcePeek(...args),
  revertAndCloseSourcePeek: (...args: unknown[]) => mockRevertAndCloseSourcePeek(...args),
}));

import { createCodeMirrorEditor } from "./sourcePeekEditor";
import {
  sourcePeekInlineExtension,
  sourcePeekInlinePluginKey,
  EDITING_STATE_CHANGED,
  canUseSourcePeek,
  openSourcePeekInline,
  commitSourcePeek,
  revertAndCloseSourcePeek,
} from "./tiptap";

// --- Helpers ---

/** Wait until CodeMirror is live inside `root`, and return its view. */
async function liveCodeMirror(root: HTMLElement): Promise<CMEditorView> {
  await vi.waitFor(() => expect(root.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  return CMEditorView.findFromDOM(root.querySelector(".cm-editor") as HTMLElement)!;
}

/** Mount a standalone peek editor (the module's single tracked CodeMirror view). */
async function mountPeekEditor(): Promise<HTMLElement> {
  const noop = () => undefined;
  const container = createCodeMirrorEditor("x", noop, noop, noop);
  document.body.appendChild(container);
  await liveCodeMirror(container);
  return container;
}

const peekEditorMounted = (root: HTMLElement) => root.querySelector(".cm-editor") !== null;

/** Press a key combination inside a CodeMirror view, through its keymaps. */
function pressKey(cm: CMEditorView, key: string, mod = false) {
  const isMac = /Mac/.test(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: mod && isMac,
    ctrlKey: mod && !isMac,
  });
  return runScopeHandlers(cm, event, "editor");
}

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: { inline: true },
  },
});

function createDoc(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
}

function getPlugin() {
  const plugins = sourcePeekInlineExtension.config.addProseMirrorPlugins!.call({
    name: "sourcePeekInline",
    options: {},
    storage: {},
    parent: null as never,
    editor: {} as never,
    type: "extension" as never,
  });
  return plugins[0];
}

function initPluginState(plugin: ReturnType<typeof getPlugin>) {
  return plugin.spec.state!.init!(
    {} as never,
    EditorState.create({ doc: createDoc("hello"), schema })
  );
}

function applyPluginState(
  plugin: ReturnType<typeof getPlugin>,
  tr: Transaction,
  prevState: { decorations: DecorationSet; editingPos: number | null },
  newState: EditorState
) {
  return plugin.spec.state!.apply!(
    tr,
    prevState,
    newState,
    newState
  );
}

describe("sourcePeekInlineExtension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.isOpen = false;
    mockStoreState.range = null;
    mockStoreState.markdown = "";
    mockStoreState.blockTypeName = null;
    mockStoreState.hasUnsavedChanges = false;
    mockStoreState.livePreview = false;
  });

  it("has name 'sourcePeekInline'", () => {
    expect(sourcePeekInlineExtension.name).toBe("sourcePeekInline");
  });

  it("defines ProseMirror plugins", () => {
    expect(sourcePeekInlineExtension.config.addProseMirrorPlugins).toBeDefined();
  });

  it("creates a plugin with correct key", () => {
    const plugin = getPlugin();
    expect(plugin).toBeDefined();
    expect(plugin.spec.key).toBe(sourcePeekInlinePluginKey);
  });
});

describe("plugin state init", () => {
  it("returns empty decorations and null editingPos", () => {
    const plugin = getPlugin();
    const state = initPluginState(plugin);
    expect(state.decorations).toBe(DecorationSet.empty);
    expect(state.editingPos).toBeNull();
  });
});

describe("plugin state apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.isOpen = false;
    mockStoreState.range = null;
    mockStoreState.markdown = "";
    mockStoreState.blockTypeName = null;
    mockStoreState.hasUnsavedChanges = false;
    mockStoreState.livePreview = false;
  });

  it("returns empty decorations and cleans up when not open", async () => {
    const peek = await mountPeekEditor();
    const plugin = getPlugin();
    const prevState = { decorations: DecorationSet.empty, editingPos: null };
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr;

    const result = applyPluginState(plugin, tr, prevState, editorState);
    expect(result.decorations).toBe(DecorationSet.empty);
    expect(result.editingPos).toBeNull();
    expect(peekEditorMounted(peek)).toBe(false);
  });

  it("returns empty decorations when open but no range", async () => {
    const peek = await mountPeekEditor();
    mockStoreState.isOpen = true;
    mockStoreState.range = null;

    const plugin = getPlugin();
    const prevState = { decorations: DecorationSet.empty, editingPos: null };
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr;

    const result = applyPluginState(plugin, tr, prevState, editorState);
    expect(result.decorations).toBe(DecorationSet.empty);
    expect(peekEditorMounted(peek)).toBe(false);
  });

  it("creates decorations when open with range and editingChanged meta", () => {
    mockStoreState.isOpen = true;
    mockStoreState.range = { from: 0, to: 7 };
    mockStoreState.markdown = "# Hello";

    const plugin = getPlugin();
    const prevState = { decorations: DecorationSet.empty, editingPos: null };
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr.setMeta("sourcePeekEditingChanged", true);

    const result = applyPluginState(plugin, tr, prevState, editorState);
    expect(result.decorations).not.toBe(DecorationSet.empty);
    expect(result.editingPos).toBe(0);
  });

  it("maps existing decorations when no editing change and same pos", () => {
    mockStoreState.isOpen = true;
    mockStoreState.range = { from: 0, to: 7 };

    const plugin = getPlugin();
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });

    // First, create decorations
    const tr1 = editorState.tr.setMeta("sourcePeekEditingChanged", true);
    const state1 = applyPluginState(plugin, tr1, { decorations: DecorationSet.empty, editingPos: null }, editorState);

    // Then apply without editing change - should map decorations
    const tr2 = editorState.tr;
    const result = applyPluginState(plugin, tr2, state1, editorState);
    expect(result.editingPos).toBe(0);
    // Decorations are mapped, not rebuilt
    expect(result.decorations).not.toBe(DecorationSet.empty);
  });

  it("returns empty when node not found at range.from", () => {
    mockStoreState.isOpen = true;
    // Position 1 is inside the paragraph text, not at a node boundary
    // doc.nodeAt(1) for "hello" inside a paragraph returns a text node
    // We need a position where nodeAt returns null — use position just before doc end
    // Actually, for this simple doc: doc(paragraph("hello")),
    // pos 0 = paragraph, pos 1-5 = text. nodeAt(6) = null (end of paragraph)
    mockStoreState.range = { from: 6, to: 7 };

    const plugin = getPlugin();
    const prevState = { decorations: DecorationSet.empty, editingPos: null };
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr.setMeta("sourcePeekEditingChanged", true);

    // nodeAt(6) should be null (end of paragraph node, before doc close)
    const nodeAtPos = editorState.doc.nodeAt(6);
    // If nodeAt returns something, try position 7 (doc end)
    if (nodeAtPos !== null) {
      mockStoreState.range = { from: 7, to: 8 };
    }

    const result = applyPluginState(plugin, tr, prevState, editorState);
    expect(result.decorations).toBe(DecorationSet.empty);
    expect(result.editingPos).toBeNull();
  });

  it("applies source-peek-live class when livePreview is on", () => {
    mockStoreState.isOpen = true;
    mockStoreState.range = { from: 0, to: 7 };
    mockStoreState.livePreview = true;

    const plugin = getPlugin();
    const prevState = { decorations: DecorationSet.empty, editingPos: null };
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr.setMeta("sourcePeekEditingChanged", true);

    const result = applyPluginState(plugin, tr, prevState, editorState);
    expect(result.decorations).not.toBe(DecorationSet.empty);

    // Check that the node decoration has the live class
    const decos = result.decorations.find();
    const nodeDecos = decos.filter((d: { type: { attrs: unknown } }) => d.type.attrs);
    expect(nodeDecos.length).toBeGreaterThan(0);
    const nodeDecoAttrs = nodeDecos[0].type.attrs as Record<string, string>;
    expect(nodeDecoAttrs.class).toContain("source-peek-live");
  });

  it("applies source-peek-editing class without live when livePreview is off", () => {
    mockStoreState.isOpen = true;
    mockStoreState.range = { from: 0, to: 7 };
    mockStoreState.livePreview = false;

    const plugin = getPlugin();
    const prevState = { decorations: DecorationSet.empty, editingPos: null };
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr.setMeta("sourcePeekEditingChanged", true);

    const result = applyPluginState(plugin, tr, prevState, editorState);
    const decos = result.decorations.find();
    const nodeDecos = decos.filter((d: { type: { attrs: unknown } }) => d.type.attrs);
    expect(nodeDecos.length).toBeGreaterThan(0);
    const nodeDecoAttrs = nodeDecos[0].type.attrs as Record<string, string>;
    expect(nodeDecoAttrs.class).toBe("source-peek-editing");
  });

  it("uses blockTypeName from store when available", () => {
    mockStoreState.isOpen = true;
    mockStoreState.range = { from: 0, to: 7 };
    mockStoreState.blockTypeName = "heading";

    const plugin = getPlugin();
    const prevState = { decorations: DecorationSet.empty, editingPos: null };
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr.setMeta("sourcePeekEditingChanged", true);

    const result = applyPluginState(plugin, tr, prevState, editorState);

    // Render the widget to trigger the factory
    const decos = result.decorations.find();
    const widgetDeco = decos.find(
      (d: { spec: { key?: string } }) => d.spec?.key?.startsWith("source-peek:")
    );
    const mockView = { state: editorState, dispatch: vi.fn() };
    const widgetEl = widgetDeco.type.toDOM(mockView) as HTMLElement;

    // The header names the store's block type, not the node's own type
    expect(widgetEl.querySelector(".source-peek-inline-block-type")?.textContent).toBe("Heading");
  });
});

describe("widget factory callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.isOpen = true;
    mockStoreState.range = { from: 0, to: 7 };
    mockStoreState.markdown = "hello";
    mockStoreState.blockTypeName = null;
    mockStoreState.hasUnsavedChanges = false;
    mockStoreState.livePreview = false;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  /** Apply an editing-changed transaction and render the peek widget. */
  function renderWidget() {
    const plugin = getPlugin();
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr.setMeta("sourcePeekEditingChanged", true);
    const result = applyPluginState(plugin, tr, { decorations: DecorationSet.empty, editingPos: null }, editorState);
    const widgetDeco = result.decorations.find().find(
      (d: { spec: { key?: string } }) => d.spec?.key?.startsWith("source-peek:")
    );
    expect(widgetDeco).toBeDefined();
    const mockView = { state: editorState, dispatch: vi.fn() };
    const widgetEl = widgetDeco.type.toDOM(mockView) as HTMLElement;
    document.body.appendChild(widgetEl);
    return { widgetEl, mockView };
  }

  it("is lazy: no widget DOM exists until the decoration is rendered", () => {
    const plugin = getPlugin();
    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const tr = editorState.tr.setMeta("sourcePeekEditingChanged", true);
    applyPluginState(plugin, tr, { decorations: DecorationSet.empty, editingPos: null }, editorState);

    expect(document.querySelector(".source-peek-inline")).toBeNull();
  });

  it("loads the store's markdown into the CodeMirror editor", async () => {
    const { widgetEl } = renderWidget();
    expect(widgetEl).toBeInstanceOf(HTMLDivElement);
    expect(widgetEl.className).toBe("source-peek-inline");

    const cm = await liveCodeMirror(widgetEl);
    expect(cm.state.doc.toString()).toBe("hello");
  });

  it("CodeMirror onChange callback updates store and applies live preview", async () => {
    const { widgetEl, mockView } = renderWidget();
    const cm = await liveCodeMirror(widgetEl);
    const replaceAll = (text: string) =>
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });

    // Without live preview
    mockStoreState.livePreview = false;
    replaceAll("new markdown");
    expect(mockStoreState.setMarkdown).toHaveBeenCalledWith("new markdown");
    expect(mockApplySourcePeekMarkdown).not.toHaveBeenCalled();

    // With live preview
    mockStoreState.livePreview = true;
    mockStoreState.range = { from: 0, to: 7 };
    replaceAll("updated md");
    expect(mockStoreState.setMarkdown).toHaveBeenCalledWith("updated md");
    expect(mockApplySourcePeekMarkdown).toHaveBeenCalledWith(
      mockView,
      { from: 0, to: 7 },
      "updated md",
      {}
    );
    expect(mockGetExpandedSourcePeekRange).toHaveBeenCalled();
    expect(mockSetState).toHaveBeenCalledWith({ range: { from: 0, to: 10 } });
  });

  it("Mod-Enter commits and Escape reverts from inside CodeMirror", async () => {
    const { widgetEl, mockView } = renderWidget();
    const cm = await liveCodeMirror(widgetEl);

    expect(pressKey(cm, "Enter", true)).toBe(true);
    expect(mockCommitSourcePeek).toHaveBeenCalledWith(mockView);

    expect(pressKey(cm, "Escape")).toBe(true);
    expect(mockRevertAndCloseSourcePeek).toHaveBeenCalledWith(mockView);
  });

  it("live preview onChange skips when range is null", async () => {
    const { widgetEl } = renderWidget();
    const cm = await liveCodeMirror(widgetEl);

    // Set live preview on but range is null
    mockStoreState.livePreview = true;
    mockStoreState.range = null;

    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "test" } });
    expect(mockStoreState.setMarkdown).toHaveBeenCalledWith("test");
    expect(mockApplySourcePeekMarkdown).not.toHaveBeenCalled();
  });

  it("header buttons revert, commit and toggle live preview", () => {
    const { widgetEl, mockView } = renderWidget();
    const header = widgetEl.querySelector(".source-peek-inline-header") as HTMLElement;

    (header.querySelector(".vm-icon-btn--danger") as HTMLButtonElement).click();
    expect(mockRevertAndCloseSourcePeek).toHaveBeenCalledWith(mockView);

    (header.querySelector(".vm-icon-btn--primary") as HTMLButtonElement).click();
    expect(mockCommitSourcePeek).toHaveBeenCalledWith(mockView);

    (header.querySelector(".source-peek-live-toggle") as HTMLButtonElement).click();
    expect(mockStoreState.toggleLivePreview).toHaveBeenCalled();
    expect(mockView.dispatch).toHaveBeenCalled();
  });
});

describe("plugin decorations prop", () => {
  it("returns decorations from plugin state", () => {
    const plugin = getPlugin();
    const decorationsFn = plugin.spec.props?.decorations;
    expect(decorationsFn).toBeDefined();

    const editorState = EditorState.create({ doc: createDoc("hello"), schema, plugins: [plugin] });
    const result = decorationsFn!.call(plugin, editorState);
    expect(result).toBeDefined();
  });
});

describe("plugin view destroy", () => {
  it("tears down the peek editor on destroy", async () => {
    const peek = await mountPeekEditor();
    const plugin = getPlugin();
    const viewSpec = plugin.spec.view!({} as never);
    expect(viewSpec.destroy).toBeDefined();

    viewSpec.destroy!();
    expect(peekEditorMounted(peek)).toBe(false);
  });
});

describe("re-exports", () => {
  it("exports sourcePeekInlinePluginKey", () => {
    expect(sourcePeekInlinePluginKey).toBeDefined();
  });

  it("exports EDITING_STATE_CHANGED", () => {
    expect(EDITING_STATE_CHANGED).toBe("sourcePeekEditingChanged");
  });

  it("exports canUseSourcePeek", () => {
    expect(canUseSourcePeek).toBeTypeOf("function");
  });

  it("exports openSourcePeekInline", () => {
    expect(openSourcePeekInline).toBeTypeOf("function");
  });

  it("exports commitSourcePeek", () => {
    expect(commitSourcePeek).toBeTypeOf("function");
  });

  it("exports revertAndCloseSourcePeek", () => {
    expect(revertAndCloseSourcePeek).toBeTypeOf("function");
  });
});
