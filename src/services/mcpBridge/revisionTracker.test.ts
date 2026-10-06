// WI-RA1C.1 — a programmatic load (mount, tab switch, split pane) keeps the
// revision an MCP client holds; a real edit still invalidates it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { initializeRevisionTracking } from "./revisionTracker";
import { setContentWithoutHistory } from "@/components/Editor/tiptapContentLoad";
import { useRevisionStore } from "@/stores/documentStore";

const TAB = "tab-track";
const OTHER = "tab-other";
const SENTINEL = "test-sentinel";

const editors: Editor[] = [];

/** A real editor, so the transactions under test are the ones Tiptap emits. */
function mountEditor(html = "<p>start</p>"): Editor {
  const editor = new Editor({ extensions: [StarterKit], content: html });
  editors.push(editor);
  return editor;
}

/** A parsed document, the way a load hands one to the editor. */
function docOf(editor: Editor, text: string) {
  return editor.schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
  });
}

const revisionOf = (tabId: string) => useRevisionStore.getState().getRevision(tabId);

beforeEach(() => {
  useRevisionStore.setState({ revisions: { [TAB]: { revision: SENTINEL, lastUpdated: 0 } } });
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("initializeRevisionTracking — init", () => {
  it("keeps an existing tab revision on init (no false STALE on remount)", () => {
    // A revision already exists for this tab (e.g. an MCP client read it while
    // the tab was a background tab). Mounting the editor must NOT reset it.
    initializeRevisionTracking(mountEditor(), TAB);
    expect(revisionOf(TAB)).toBe(SENTINEL);
  });

  it("lazily initializes a revision for a never-tracked tab on init", () => {
    initializeRevisionTracking(mountEditor(), "fresh-tab");
    expect(revisionOf("fresh-tab")).toMatch(/^rev-[A-Za-z0-9]{8}$/);
  });
});

describe("initializeRevisionTracking — programmatic loads", () => {
  it("keeps the revision when the mounted editor loads the tab's document", () => {
    const editor = mountEditor("");
    initializeRevisionTracking(editor, TAB);

    setContentWithoutHistory(editor, docOf(editor, "loaded from the store"));

    // The load really replaced the document — otherwise this proves nothing.
    expect(editor.getText()).toBe("loaded from the store");
    expect(revisionOf(TAB)).toBe(SENTINEL);
  });

  it("keeps the revision across a remount of the same tab (tab switch and back)", () => {
    const first = mountEditor("");
    initializeRevisionTracking(first, TAB);
    setContentWithoutHistory(first, docOf(first, "document"));
    first.destroy();

    const second = mountEditor("");
    initializeRevisionTracking(second, TAB);
    setContentWithoutHistory(second, docOf(second, "document"));

    expect(second.getText()).toBe("document");
    expect(revisionOf(TAB)).toBe(SENTINEL);
  });

  it("keeps the revision when a second editor for the tab loads it (split pane)", () => {
    const focused = mountEditor("");
    const pane = mountEditor("");
    initializeRevisionTracking(focused, TAB);
    initializeRevisionTracking(pane, TAB);

    setContentWithoutHistory(focused, docOf(focused, "document"));
    setContentWithoutHistory(pane, docOf(pane, "document"));

    expect(pane.getText()).toBe("document");
    expect(revisionOf(TAB)).toBe(SENTINEL);
  });

  it("keeps the revision for Tiptap's own setContent with emitUpdate off", () => {
    const editor = mountEditor("");
    initializeRevisionTracking(editor, TAB);

    editor.commands.setContent("<p>loaded</p>", { emitUpdate: false });

    expect(editor.getText()).toBe("loaded");
    expect(revisionOf(TAB)).toBe(SENTINEL);
  });

  it("keeps the revision for a load of an empty and of a CJK document", () => {
    const editor = mountEditor("<p>before</p>");
    initializeRevisionTracking(editor, TAB);

    setContentWithoutHistory(editor, docOf(editor, ""));
    expect(editor.getText()).toBe("");
    setContentWithoutHistory(editor, docOf(editor, "中文文档 🙂"));

    expect(editor.getText()).toBe("中文文档 🙂");
    expect(revisionOf(TAB)).toBe(SENTINEL);
  });
});

describe("initializeRevisionTracking — edits", () => {
  it("bumps the tab's revision on a real edit", () => {
    const editor = mountEditor();
    initializeRevisionTracking(editor, TAB);

    editor.commands.insertContent("typed");

    expect(revisionOf(TAB)).not.toBe(SENTINEL);
  });

  it("bumps on an edit made after a load", () => {
    const editor = mountEditor("");
    initializeRevisionTracking(editor, TAB);
    setContentWithoutHistory(editor, docOf(editor, "loaded"));

    editor.commands.insertContent("typed");

    expect(editor.getText()).toContain("typed");
    expect(revisionOf(TAB)).not.toBe(SENTINEL);
  });

  it("bumps again on each further edit", () => {
    const editor = mountEditor();
    initializeRevisionTracking(editor, TAB);

    editor.commands.insertContent("a");
    const afterFirst = revisionOf(TAB);
    editor.commands.insertContent("b");

    expect(afterFirst).not.toBe(SENTINEL);
    expect(revisionOf(TAB)).not.toBe(afterFirst);
  });

  it("bumps when the user undoes a load that was recorded in history", () => {
    // A bridge write is loaded with the load mark but stays undoable. Undoing
    // it is the user changing the document, and must invalidate held revisions.
    const editor = mountEditor("<p>before</p>");
    initializeRevisionTracking(editor, TAB);
    const { view } = editor;
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, docOf(editor, "written").content)
        .setMeta("addToHistory", true)
        .setMeta("preventUpdate", true),
    );
    const afterLoad = revisionOf(TAB);

    editor.commands.undo();

    expect(editor.getText()).toBe("before");
    expect(revisionOf(TAB)).not.toBe(afterLoad);
  });

  it("leaves the tab's revision unchanged on a selection-only transaction", () => {
    const editor = mountEditor("<p>some text</p>");
    initializeRevisionTracking(editor, TAB);

    editor.commands.setTextSelection({ from: 2, to: 5 });

    expect(editor.state.selection.empty).toBe(false);
    expect(revisionOf(TAB)).toBe(SENTINEL);
  });

  it("only bumps its own tab, not others", () => {
    const editor = mountEditor();
    initializeRevisionTracking(editor, TAB);
    const otherBefore = revisionOf(OTHER);

    editor.commands.insertContent("typed");

    expect(revisionOf(OTHER)).toBe(otherBefore);
  });
});
