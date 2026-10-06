/**
 * Tests for editorPlugins.tiptap — inner callback execution paths.
 * Formatting/link/line/transform shortcuts now delegate to the shared editor
 * executor, so these verify the terminal runEditorAction dispatch (<actionId>).
 * The bindings that stay direct (unlink, pastePlainText, sourcePeek — no editor
 * action) are asserted by their effect: on a real editor view for unlink and
 * Source Peek, and at the clipboard boundary for pastePlainText.
 *
 * The keymap reads its chords through the hostShortcuts seam, which binds
 * nothing by default — so `beforeEach` points it at the shortcuts store the
 * way the app does at startup. Every binding is looked up through
 * `boundCommand`, which throws on a missing chord: unbound, the keymap holds
 * only Escape and undo/redo, and a lookup that skipped instead would pass
 * every test here without running one of them.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Spy on runEditorAction — the terminal call for every routed shortcut.
const { runEditorActionMock } = vi.hoisted(() => ({
  runEditorActionMock: vi.fn(),
}));
vi.mock("@/services/editor/runEditorAction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/editor/runEditorAction")>();
  return { ...actual, runEditorAction: (...args: unknown[]) => runEditorActionMock(...args) };
});
vi.mock("@/plugins/markdownPaste/tiptap", () => ({
  triggerPastePlainText: vi.fn(() => Promise.resolve()),
}));
// These two moved to unifiedUndoRedo.ts when unifiedHistory.ts was split for
// the size gate; mocking the old path leaves the mock INERT and silently runs
// the real commands.
vi.mock("@/services/history/unifiedUndoRedo", () => ({
  performUnifiedUndo: vi.fn(() => true),
  performUnifiedRedo: vi.fn(() => true),
}));

import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Command, type Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { useShortcutsStore } from "@/stores/settingsStore";
import { useSourcePeekStore } from "@/stores/sourcePeekStore";
import { bindPluginHostSettings } from "@/services/assembly/bindHostSettings";
import { parseMarkdown } from "@/utils/markdownPipeline";
import { toProseMirrorKey } from "@/utils/keybinding/proseMirrorKey";
import { buildEditorKeymapBindings } from "./editorPlugins.tiptap";
import { EDITING_STATE_CHANGED } from "@/plugins/sourcePeekInline/sourcePeekActions";
import { triggerPastePlainText } from "@/plugins/markdownPaste/tiptap";

const schema = getSchema([StarterKit]);

/** A mounted editor and every transaction it dispatched. */
interface TestEditor {
  view: EditorView;
  dispatched: Transaction[];
}

const mounted: EditorView[] = [];

/** A real editor view over `markdown`, with the cursor at `cursor`. */
function createEditor(markdown = "Hello world", cursor = 1): TestEditor {
  const doc = parseMarkdown(schema, markdown);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
  const dispatched: Transaction[] = [];
  const view: EditorView = new EditorView(document.createElement("div"), {
    state,
    dispatchTransaction(tr) {
      dispatched.push(tr);
      view.updateState(view.state.apply(tr));
    },
  });
  mounted.push(view);
  return { view, dispatched };
}

/** Run a keymap command the way ProseMirror's keydown handler does. */
function run(command: Command, view: EditorView): boolean {
  return command(view.state, (tr) => view.dispatch(tr), view);
}

/** The command bound to a shortcut's chord. Throws, never skips, when there is none. */
function boundCommand(bindings: Record<string, Command>, shortcutId: string): Command {
  const chord = useShortcutsStore.getState().getShortcut(shortcutId);
  if (!chord) throw new Error(`shortcut "${shortcutId}" has no chord`);
  const command = bindings[toProseMirrorKey(chord)];
  if (!command) throw new Error(`shortcut "${shortcutId}" (${chord}) is not bound`);
  return command;
}

/** Whether any text in `doc` carries a link mark. */
function hasLink(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.marks.some((mark) => mark.type.name === "link")) found = true;
  });
  return found;
}

beforeEach(bindPluginHostSettings);

afterEach(() => {
  useShortcutsStore.setState({ customBindings: {} });
  useSourcePeekStore.getState().close();
  for (const view of mounted.splice(0)) view.destroy();
  vi.clearAllMocks();
});

describe("buildEditorKeymapBindings callback execution with view", () => {
  it("inline mark formatting bindings dispatch <mark> via the editor executor", () => {
    const bindings = buildEditorKeymapBindings();
    const { view } = createEditor();

    const markMap: Record<string, string> = {
      bold: "bold", italic: "italic", code: "code",
      strikethrough: "strikethrough", underline: "underline",
      highlight: "highlight", subscript: "subscript", superscript: "superscript",
    };

    for (const [name, actionId] of Object.entries(markMap)) {
      runEditorActionMock.mockClear();
      const result = run(boundCommand(bindings, name), view);
      expect(result).toBe(true);
      expect(runEditorActionMock).toHaveBeenCalledWith(actionId, expect.any(Object));
    }
  });

  it("link binding dispatches link", () => {
    const { view } = createEditor();
    const result = run(boundCommand(buildEditorKeymapBindings(), "link"), view);
    expect(result).toBe(true);
    expect(runEditorActionMock).toHaveBeenCalledWith("link", expect.any(Object));
  });

  it("unlink binding removes the link under the cursor and keeps its text", () => {
    // Cursor inside "docs" (positions 5–9), which is the link's text.
    const { view, dispatched } = createEditor("see [docs](https://example.test) here", 6);
    expect(hasLink(view.state.doc)).toBe(true);

    const result = run(boundCommand(buildEditorKeymapBindings(), "unlink"), view);

    expect(result).toBe(true);
    expect(hasLink(view.state.doc)).toBe(false);
    expect(view.state.doc.textContent).toBe("see docs here");
    // Without this meta, Tiptap's Link extension would re-add the mark it removed.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.getMeta("preventAutolink")).toBe(true);
  });

  it("wikiLink binding dispatches wikiLink", () => {
    const { view } = createEditor();
    const result = run(boundCommand(buildEditorKeymapBindings(), "wikiLink"), view);
    expect(result).toBe(true);
    expect(runEditorActionMock).toHaveBeenCalledWith("wikiLink", expect.any(Object));
  });

  it("bookmarkLink binding dispatches bookmark", () => {
    const { view } = createEditor();
    const result = run(boundCommand(buildEditorKeymapBindings(), "bookmarkLink"), view);
    expect(result).toBe(true);
    expect(runEditorActionMock).toHaveBeenCalledWith("bookmark", expect.any(Object));
  });

  it("inlineMath binding dispatches insertInlineMath", () => {
    const { view } = createEditor();
    const result = run(boundCommand(buildEditorKeymapBindings(), "inlineMath"), view);
    expect(result).toBe(true);
    expect(runEditorActionMock).toHaveBeenCalledWith("insertInlineMath", expect.any(Object));
  });

  it("pastePlainText binding calls triggerPastePlainText with view", () => {
    const { view } = createEditor();
    const result = run(boundCommand(buildEditorKeymapBindings(), "pastePlainText"), view);
    expect(result).toBe(true);
    expect(triggerPastePlainText).toHaveBeenCalledWith(view);
  });

  it("line operation bindings dispatch their editor actions", () => {
    const bindings = buildEditorKeymapBindings();
    const { view } = createEditor();

    const ops: Record<string, string> = {
      moveLineUp: "moveLineUp",
      moveLineDown: "moveLineDown",
      duplicateLine: "duplicateLine",
      deleteLine: "deleteLine",
      joinLines: "joinLines",
    };

    for (const [name, actionId] of Object.entries(ops)) {
      runEditorActionMock.mockClear();
      const result = run(boundCommand(bindings, name), view);
      expect(result).toBe(true);
      expect(runEditorActionMock).toHaveBeenCalledWith(actionId, expect.any(Object));
    }
  });

  it("text transform bindings dispatch their editor actions", () => {
    // Toggle Case ships with no default chord, so it is bound only once the
    // user assigns one; this one collides with no default.
    useShortcutsStore.setState({ customBindings: { transformToggleCase: "Ctrl-Shift-g" } });
    const bindings = buildEditorKeymapBindings();
    const { view } = createEditor();

    const transforms: Record<string, string> = {
      transformUppercase: "transformUppercase",
      transformLowercase: "transformLowercase",
      transformTitleCase: "transformTitleCase",
      transformToggleCase: "transformToggleCase",
    };

    for (const [name, actionId] of Object.entries(transforms)) {
      runEditorActionMock.mockClear();
      const result = run(boundCommand(bindings, name), view);
      expect(result).toBe(true);
      expect(runEditorActionMock).toHaveBeenCalledWith(actionId, expect.any(Object));
    }
  });

  it("sourcePeek binding opens an inline Source Peek on the cursor's block when none is open", () => {
    const { view, dispatched } = createEditor("Alpha\n\nBeta", 1);
    expect(useSourcePeekStore.getState().isOpen).toBe(false);

    const result = run(boundCommand(buildEditorKeymapBindings(), "sourcePeek"), view);

    expect(result).toBe(true);
    // The peek holds the first paragraph — its range and its markdown — not
    // the whole document.
    const peek = useSourcePeekStore.getState();
    expect(peek.isOpen).toBe(true);
    expect(peek.blockTypeName).toBe("paragraph");
    expect(peek.range).toEqual({ from: 0, to: 7 });
    expect(peek.markdown.trim()).toBe("Alpha");
    // The plugin rebuilds its decorations only on this meta.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.getMeta(EDITING_STATE_CHANGED)).toBe(true);
  });
});
