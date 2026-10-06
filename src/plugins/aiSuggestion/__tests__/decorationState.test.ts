// WI-RA10B.8 — suggestion decorations are built when the suggestions change,
// carried through document edits by mapping, and left alone otherwise; their
// widgets carry keys, so an unchanged suggestion keeps its DOM.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Plugin } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";

vi.mock("../ai-suggestion.css", () => ({}));
import { aiSuggestionExtension } from "../tiptap";
import type { AiSuggestion, AiSuggestionStore } from "../types";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: { inline: true },
  },
});

/** A registry that replaces its map on every change, as the app's store does. */
function createStore() {
  const state = {
    suggestions: new Map<string, AiSuggestion>(),
    focusedSuggestionId: null as string | null,
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as AiSuggestionStore;
  return {
    store,
    set(suggestions: AiSuggestion[], focused: string | null = null) {
      state.suggestions = new Map(suggestions.map((s) => [s.id, s]));
      state.focusedSuggestionId = focused;
    },
  };
}

const suggestion = (overrides: Partial<AiSuggestion>): AiSuggestion => ({
  id: "s1",
  tabId: "tab-1",
  type: "insert",
  from: 1,
  to: 1,
  createdAt: 0,
  ...overrides,
});

let registry: ReturnType<typeof createStore>;
let plugin: Plugin;

function stateOf(text: string): EditorState {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]);
  return EditorState.create({ doc, schema, plugins: [plugin] });
}

const decorationsOf = (state: EditorState): DecorationSet =>
  plugin.props.decorations!.call(plugin, state) as DecorationSet;

const widgetsOf = (state: EditorState): Decoration[] =>
  decorationsOf(state)
    .find()
    .filter((d) => d.from === d.to);

const keysOf = (state: EditorState): unknown[] => widgetsOf(state).map((d) => (d.spec as { key?: string }).key);

/** A transaction that changes nothing, as the plugin dispatches after a store change. */
const refreshed = (state: EditorState): EditorState => state.apply(state.tr);

beforeEach(() => {
  registry = createStore();
  const context = {
    name: aiSuggestionExtension.name,
    options: { store: registry.store },
    storage: aiSuggestionExtension.storage,
  };
  plugin = (aiSuggestionExtension.config.addProseMirrorPlugins?.call(context as never) ?? [])[0];
});

describe("ai suggestion decorations — when they are rebuilt", () => {
  it("returns the same set for a cursor move", () => {
    registry.set([suggestion({ type: "replace", from: 1, to: 6, newContent: "howdy" })], "s1");
    const state = stateOf("hello world");
    const before = decorationsOf(state);
    expect(before.find()).toHaveLength(2);

    const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 8)));
    expect(decorationsOf(moved)).toBe(before);
  });

  it("returns the same set for a refresh when the suggestions did not change", () => {
    registry.set([suggestion({ newContent: "x" })]);
    const state = stateOf("hello world");
    expect(decorationsOf(refreshed(state))).toBe(decorationsOf(state));
  });

  it("carries decorations through an edit before the suggestion by mapping them", () => {
    registry.set([suggestion({ type: "delete", from: 7, to: 12 })]);
    const state = stateOf("hello world");

    // The registry has not been told about the edit yet: positions come from mapping.
    const typed = state.apply(state.tr.insertText("abc", 1));
    const [strike] = decorationsOf(typed).find();
    expect([strike.from, strike.to]).toEqual([10, 15]);
  });

  it("rebuilds from the registry once it reports new positions", () => {
    registry.set([suggestion({ type: "delete", from: 7, to: 12 })]);
    const state = stateOf("hello world");
    const typed = state.apply(state.tr.insertText("abc", 1));

    registry.set([suggestion({ type: "delete", from: 10, to: 15 })]);
    const [strike] = decorationsOf(refreshed(typed)).find();
    expect([strike.from, strike.to]).toEqual([10, 15]);
  });

  it("builds a suggestion added in the same step as an edit against the document it was made for", () => {
    const state = stateOf("hello world");
    expect(decorationsOf(state).find()).toHaveLength(0);

    registry.set([suggestion({ type: "delete", from: 7, to: 12 })]);
    const typed = state.apply(state.tr.insertText("abc", 1));
    const [strike] = decorationsOf(typed).find();
    expect([strike.from, strike.to]).toEqual([10, 15]);
  });

  it("drops every decoration when the last suggestion goes", () => {
    registry.set([suggestion({ newContent: "x" })]);
    const state = stateOf("hello world");
    expect(decorationsOf(state).find()).toHaveLength(1);

    registry.set([]);
    expect(decorationsOf(refreshed(state)).find()).toHaveLength(0);
  });
});

describe("ai suggestion decorations — widget keys", () => {
  it("gives every widget a key", () => {
    registry.set(
      [
        suggestion({ id: "a", type: "insert", from: 1, to: 1, newContent: "x" }),
        suggestion({ id: "b", type: "replace", from: 2, to: 4, newContent: "y" }),
        suggestion({ id: "c", type: "delete", from: 5, to: 7 }),
      ],
      "c",
    );
    const keys = keysOf(stateOf("hello world"));
    expect(keys).toHaveLength(3);
    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps an unchanged suggestion's key when another suggestion changes", () => {
    const stay = suggestion({ id: "stay", from: 1, to: 1, newContent: "x" });
    registry.set([stay, suggestion({ id: "other", from: 6, to: 6, newContent: "y" })]);
    const state = stateOf("hello world");
    const [stayKey] = keysOf(state);

    registry.set([stay, suggestion({ id: "other", from: 6, to: 6, newContent: "changed" })]);
    const after = keysOf(refreshed(state));
    expect(after[0]).toBe(stayKey);
    expect(after[1]).not.toBe(keysOf(state)[1]);
  });

  it.each([
    { name: "gains focus", next: suggestion({ newContent: "x" }), focused: "s1" },
    { name: "gets different content", next: suggestion({ newContent: "y" }), focused: null },
    // Its buttons act on the range the widget was built with, so a moved
    // suggestion must be drawn again.
    { name: "moves", next: suggestion({ from: 3, to: 3, newContent: "x" }), focused: null },
  ])("changes the key when the suggestion $name", ({ next, focused }) => {
    registry.set([suggestion({ newContent: "x" })]);
    const state = stateOf("hello world");
    const [before] = keysOf(state);

    registry.set([next], focused);
    expect(keysOf(refreshed(state))[0]).not.toBe(before);
  });
});
