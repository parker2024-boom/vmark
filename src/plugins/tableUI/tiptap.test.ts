/**
 * Tests for tiptap.ts (Table UI Extension)
 *
 * Covers: extension metadata, plugin key, plugin state init/apply,
 * TiptapTableUIPluginView (constructor/update/destroy), the in-table keymap
 * (row insertion and arrow escape), and the contextmenu DOM event handler.
 *
 * Strategy: every table collaborator is REAL — the context menu, the column
 * resize manager, the DOM lookup, the row actions (prosemirror-tables) and the
 * arrow escape — so each test asserts what the user would see: rows added, a
 * paragraph inserted, resize handles mounted, a menu shown. The only double is
 * the EditorView object itself (a plain object over a real EditorState), plus
 * the stylesheet import, which carries no logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./table-ui.css", () => ({}));

import { tableUIExtension, tiptapTableUIPluginKey } from "./tiptap";
import { TiptapTableContextMenu } from "./TiptapTableContextMenu";
import { Schema, type Node as PmNode } from "@tiptap/pm/model";
import { EditorState, Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { tableNodes } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

// ---------- Schema & helpers ----------

const tables = tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} });

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline", inline: true },
    table: tables.table,
    table_row: tables.table_row,
    table_cell: tables.table_cell,
    table_header: tables.table_header,
  },
});

function createDoc(): PmNode {
  return schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [schema.text("hello")]),
  ]);
}

/** A document that is ONLY a 2×2 table — the table is both first and last block. */
function createTableDoc(): PmNode {
  const cell = (text: string) =>
    schema.nodes.table_cell.create(null, [schema.nodes.paragraph.create(null, [schema.text(text)])]);
  const row = (a: string, b: string) => schema.nodes.table_row.create(null, [cell(a), cell(b)]);
  return schema.nodes.doc.create(null, [schema.nodes.table.create(null, [row("a1", "b1"), row("a2", "b2")])]);
}

/** Position inside the text of the cell whose text is `text`. */
function posInCell(doc: PmNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === text) found = pos + 1;
  });
  expect(found).toBeGreaterThan(0);
  return found;
}

function rowCount(doc: PmNode): number {
  let rows = 0;
  doc.descendants((node) => {
    if (node.type.name === "table_row") rows++;
  });
  return rows;
}

function rowTexts(doc: PmNode): string[] {
  const texts: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "table_row") texts.push(node.textContent);
  });
  return texts;
}

/**
 * Extract the table-UI ProseMirror plugins from the Tiptap extension.
 * `addProseMirrorPlugins` needs a `this` context with at least `name` and `options`.
 */
function getPlugins(): Plugin[] {
  const ext = tableUIExtension as unknown as {
    config: { addProseMirrorPlugins: () => Plugin[] };
  };
  return ext.config.addProseMirrorPlugins.call({ name: "tableUI", options: {} });
}

/** PluginKey's string id is not in its public typings. */
const PLUGIN_KEY_ID = (tiptapTableUIPluginKey as unknown as { key: string }).key;

function findMainPlugin(plugins: Plugin[]): Plugin {
  return plugins.find((p) => (p as unknown as { key: string }).key === PLUGIN_KEY_ID)!;
}

/** Build an EditorState that includes the table-UI plugins. */
function createStateWithPlugins(doc: PmNode = createDoc(), plugins: Plugin[] = getPlugins()): EditorState {
  return EditorState.create({ doc, schema, plugins });
}

function withCursor(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

/** Minimal EditorView over a real EditorState: dispatch applies the transaction. */
function createMockEditorView(state: EditorState): EditorView {
  let currentState = state;
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  const view: Record<string, unknown> = {
    dom,
    get state() {
      return currentState;
    },
    dispatch(tr: Transaction) {
      currentState = currentState.apply(tr);
    },
    focus: vi.fn(),
    composing: false,
    root: document,
    // No rendered node views in this double, so no table scroll wrapper exists.
    nodeDOM: () => null,
  };
  return view as unknown as EditorView;
}

function keyHandler(plugins: Plugin[]) {
  return (plugins[0] as unknown as {
    spec: { props: { handleKeyDown: (v: EditorView, e: KeyboardEvent) => boolean } };
  }).spec.props.handleKeyDown;
}

function contextMenuHandler(plugins: Plugin[]) {
  return (findMainPlugin(plugins) as unknown as {
    spec: { props: { handleDOMEvents: { contextmenu: (v: unknown, e: unknown) => boolean } } };
  }).spec.props.handleDOMEvents.contextmenu;
}

/** prosemirror-keymap reads "Mod" as Cmd on Apple platforms and Ctrl elsewhere. */
const IS_MAC = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
function modKey(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...init, metaKey: IS_MAC, ctrlKey: !IS_MAC, bubbles: true });
}

function visibleMenus(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".table-context-menu")].filter(
    (el) => el.style.display !== "none",
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

// ---------- Tests ----------

describe("tableUIExtension metadata", () => {
  it("has name 'tableUI'", () => {
    expect(tableUIExtension.name).toBe("tableUI");
  });

  it("has priority 1050", () => {
    const config = (tableUIExtension as { config?: { priority?: number } }).config;
    expect(config?.priority).toBe(1050);
  });
});

describe("tiptapTableUIPluginKey", () => {
  it("key string contains 'tiptapTableUI'", () => {
    expect(PLUGIN_KEY_ID).toContain("tiptapTableUI");
  });
});

describe("Plugin state (init / apply)", () => {
  let state: EditorState;

  beforeEach(() => {
    state = createStateWithPlugins();
  });

  it("initialises with contextMenu: null", () => {
    // Only the state exists here — no plugin view — so init() is all that ran.
    expect(tiptapTableUIPluginKey.getState(state)).toEqual({ contextMenu: null });
  });

  it("updates state via meta", () => {
    const fakeMenu = { show: vi.fn() };
    const tr = state.tr.setMeta(tiptapTableUIPluginKey, { contextMenu: fakeMenu });
    const next = state.apply(tr);
    expect(tiptapTableUIPluginKey.getState(next)?.contextMenu).toBe(fakeMenu);
  });

  it("preserves state when transaction has no meta", () => {
    const fakeMenu = { show: vi.fn() };
    const s2 = state.apply(state.tr.setMeta(tiptapTableUIPluginKey, { contextMenu: fakeMenu }));
    const s3 = s2.apply(s2.tr.insertText("x"));
    expect(tiptapTableUIPluginKey.getState(s3)?.contextMenu).toBe(fakeMenu);
  });
});

describe("TiptapTableUIPluginView lifecycle", () => {
  let mockView: EditorView;
  let pluginViewObj: { update: (v: EditorView) => void; destroy: () => void };

  function mountPluginView(state: EditorState, plugins: Plugin[]) {
    mockView = createMockEditorView(state);
    const viewFactory = (findMainPlugin(plugins) as unknown as { spec: { view: (v: EditorView) => unknown } }).spec.view;
    pluginViewObj = viewFactory(mockView) as typeof pluginViewObj;
  }

  /** Render a real <table> into the view DOM and put the DOM caret in its first cell. */
  function renderTableWithDomCaret(): HTMLTableElement {
    const table = document.createElement("table");
    table.innerHTML = "<tr><td>a1</td><td>b1</td><td>c1</td></tr><tr><td>a2</td><td>b2</td><td>c2</td></tr>";
    mockView.dom.appendChild(table);
    const textNode = table.querySelector("td")!.firstChild!;
    document.getSelection()!.collapse(textNode, 1);
    return table;
  }

  afterEach(() => {
    try {
      pluginViewObj.destroy();
    } catch {
      // Already destroyed by the test.
    }
  });

  it("registers a real context menu in plugin state once mounting completes", async () => {
    const plugins = getPlugins();
    mountPluginView(createStateWithPlugins(createDoc(), plugins), plugins);
    // The registration is deferred out of view() initialisation.
    expect(tiptapTableUIPluginKey.getState(mockView.state)?.contextMenu).toBeNull();
    await Promise.resolve();
    expect(tiptapTableUIPluginKey.getState(mockView.state)?.contextMenu).toBeInstanceOf(TiptapTableContextMenu);
  });

  it("does not register the menu when destroyed before the deferred registration runs", async () => {
    const plugins = getPlugins();
    mountPluginView(createStateWithPlugins(createDoc(), plugins), plugins);
    pluginViewObj.destroy();
    await Promise.resolve();
    expect(tiptapTableUIPluginKey.getState(mockView.state)?.contextMenu).toBeNull();
  });

  it("update mounts column resize handles on the active table after the debounce", () => {
    vi.useFakeTimers();
    const plugins = getPlugins();
    const doc = createTableDoc();
    mountPluginView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a1")), plugins);
    const table = renderTableWithDomCaret();

    pluginViewObj.update(mockView);
    expect(table.querySelectorAll(".table-resize-handle")).toHaveLength(0);
    vi.advanceTimersByTime(200);

    // One handle between each pair of header-row columns (none after the last).
    expect(table.querySelectorAll("tr:first-child .table-resize-handle")).toHaveLength(2);
  });

  it("update does NOT mount handles when the selection is outside any table", () => {
    vi.useFakeTimers();
    const plugins = getPlugins();
    mountPluginView(withCursor(createStateWithPlugins(createDoc(), plugins), 2), plugins);
    const table = renderTableWithDomCaret();

    pluginViewObj.update(mockView);
    vi.advanceTimersByTime(1000);
    expect(table.querySelectorAll(".table-resize-handle")).toHaveLength(0);
  });

  it("update does NOT mount handles when the DOM caret is not inside a table element", () => {
    vi.useFakeTimers();
    const plugins = getPlugins();
    const doc = createTableDoc();
    mountPluginView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a1")), plugins);
    const table = renderTableWithDomCaret();
    const outside = document.createElement("p");
    outside.textContent = "outside";
    mockView.dom.appendChild(outside);
    document.getSelection()!.collapse(outside.firstChild!, 0);

    pluginViewObj.update(mockView);
    vi.advanceTimersByTime(1000);
    expect(table.querySelectorAll(".table-resize-handle")).toHaveLength(0);
  });

  it("destroy cancels a pending resize, removes the shown menu, and clears plugin state", async () => {
    vi.useFakeTimers();
    const plugins = getPlugins();
    const doc = createTableDoc();
    mountPluginView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a1")), plugins);
    await Promise.resolve();
    const menu = tiptapTableUIPluginKey.getState(mockView.state)!.contextMenu!;
    menu.show(10, 10);
    expect(visibleMenus()).toHaveLength(1);
    const table = renderTableWithDomCaret();
    pluginViewObj.update(mockView);

    pluginViewObj.destroy();
    vi.advanceTimersByTime(1000);

    expect(table.querySelectorAll(".table-resize-handle")).toHaveLength(0);
    expect(document.querySelectorAll(".table-context-menu")).toHaveLength(0);
    expect(tiptapTableUIPluginKey.getState(mockView.state)?.contextMenu).toBeNull();
  });

  it("destroy tolerates dispatch failure (view already destroyed)", () => {
    const plugins = getPlugins();
    mountPluginView(createStateWithPlugins(createDoc(), plugins), plugins);
    (mockView as unknown as { dispatch: () => void }).dispatch = () => {
      throw new Error("view destroyed");
    };
    expect(() => pluginViewObj.destroy()).not.toThrow();
  });
});

describe("in-table keymap (cmdWhenInTable)", () => {
  it("Mod-Enter outside a table is not handled and leaves the document alone", () => {
    const plugins = getPlugins();
    const view = createMockEditorView(withCursor(createStateWithPlugins(createDoc(), plugins), 2));
    const before = view.state.doc;
    expect(keyHandler(plugins)(view, modKey({ key: "Enter" }))).toBe(false);
    expect(view.state.doc.eq(before)).toBe(true);
  });

  it("Mod-Enter in a table adds a row below the current one", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a1")));
    expect(keyHandler(plugins)(view, modKey({ key: "Enter" }))).toBe(true);
    expect(rowTexts(view.state.doc)).toEqual(["a1b1", "", "a2b2"]);
  });

  it("Mod-Shift-Enter in a table adds a row above the current one", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a2")));
    expect(keyHandler(plugins)(view, modKey({ key: "Enter", shiftKey: true }))).toBe(true);
    expect(rowTexts(view.state.doc)).toEqual(["a1b1", "", "a2b2"]);
  });

  it("row insertion is suppressed during IME composition", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a1")));
    (view as unknown as { composing: boolean }).composing = true;
    expect(keyHandler(plugins)(view, modKey({ key: "Enter" }))).toBe(false);
    expect(rowCount(view.state.doc)).toBe(2);
  });

  it("ArrowUp in the first row of a leading table inserts a paragraph above it", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "b1")));
    expect(keyHandler(plugins)(view, new KeyboardEvent("keydown", { key: "ArrowUp" }))).toBe(true);
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(view.state.selection.from).toBe(1);
  });

  it("ArrowUp in a later row is left to the default behaviour", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a2")));
    expect(keyHandler(plugins)(view, new KeyboardEvent("keydown", { key: "ArrowUp" }))).toBe(false);
    expect(view.state.doc.firstChild?.type.name).toBe("table");
  });

  it("ArrowDown in the last row of a trailing table inserts a paragraph below it", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a2")));
    expect(keyHandler(plugins)(view, new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    expect(view.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(view.state.selection.$from.parent).toBe(view.state.doc.lastChild);
  });

  it("ArrowDown outside a table is not handled", () => {
    const plugins = getPlugins();
    const view = createMockEditorView(withCursor(createStateWithPlugins(createDoc(), plugins), 2));
    expect(keyHandler(plugins)(view, new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(false);
  });
});

describe("contextmenu DOM event handler", () => {
  it("returns false and leaves the native menu alone when not in a table", () => {
    const plugins = getPlugins();
    const view = createMockEditorView(withCursor(createStateWithPlugins(createDoc(), plugins), 2));
    const event = { preventDefault: vi.fn(), clientX: 100, clientY: 200 };
    expect(contextMenuHandler(plugins)(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(visibleMenus()).toHaveLength(0);
  });

  it("in a table with no menu registered yet, still swallows the native menu", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a1")));
    const event = { preventDefault: vi.fn(), clientX: 100, clientY: 200 };
    expect(contextMenuHandler(plugins)(view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(visibleMenus()).toHaveLength(0);
  });

  it("in a table, prevents default and shows the table menu at the pointer", () => {
    const plugins = getPlugins();
    const doc = createTableDoc();
    const view = createMockEditorView(withCursor(createStateWithPlugins(doc, plugins), posInCell(doc, "a1")));
    const menu = new TiptapTableContextMenu(view);
    view.dispatch(view.state.tr.setMeta(tiptapTableUIPluginKey, { contextMenu: menu }));

    const event = { preventDefault: vi.fn(), clientX: 150, clientY: 250 };
    expect(contextMenuHandler(plugins)(view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();

    const [shown] = visibleMenus();
    expect(shown).toBeDefined();
    expect(shown.style.left).toBe("150px");
    expect(shown.style.top).toBe("250px");
    menu.destroy();
  });
});
