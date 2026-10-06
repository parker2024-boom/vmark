// WI-RA1A.3 — the seam between a bridge handler and the mounted WYSIWYG
// editor: when content is loaded into the editor, when it is not, and what
// the flusher is (and is not) allowed to do afterwards.
// WI-RA18.2 — while the user composes with an IME in that editor, a write is
// refused (liveCompositionRefusal) and a load that skipped the question throws.
//
// A real Tiptap editor and the real editor store and flusher registry; no
// mocks. The end-to-end behaviour, with the production editor component
// mounted, is pinned in liveEditorWrite.test.tsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Transaction } from "@tiptap/pm/state";
import { useEditorStore } from "@/stores/editorStore";
import { registerWysiwygFlusher } from "@/utils/wysiwygFlush";
import {
  flushLiveEditors,
  liveCompositionRefusal,
  loadIntoLiveWysiwyg,
} from "@/services/mcpBridge/v2/liveEditor";

let editor: Editor;
let transactions: Transaction[];
let flushes: string[];

/** Register `editor` as the live WYSIWYG editor of `tabId`, with a flusher. */
function goLive(tabId: string): void {
  useEditorStore.getState().setTiptapEditor(editor);
  useEditorStore.getState().setActiveWysiwygEditor(editor, tabId);
  registerWysiwygFlusher(tabId, () => {
    flushes.push(editor.getText());
  });
}

beforeEach(() => {
  transactions = [];
  flushes = [];
  editor = new Editor({ extensions: [StarterKit], content: "<p>old document</p>" });
  editor.on("transaction", ({ transaction }) => {
    transactions.push(transaction);
  });
});

afterEach(() => {
  registerWysiwygFlusher("tab-live", null);
  useEditorStore.getState().setActiveWysiwygEditor(null);
  useEditorStore.getState().setTiptapEditor(null);
  editor.destroy();
  vi.restoreAllMocks();
});

describe("loadIntoLiveWysiwyg", () => {
  it("loads the content as an undoable LOAD and then flushes the editor", () => {
    goLive("tab-live");

    expect(loadIntoLiveWysiwyg("tab-live", "new document\n")).toBe(true);

    expect(editor.getText()).toBe("new document");
    expect(transactions).toHaveLength(1);
    // A load, so the editor does not write its re-serialization back as a
    // user edit; in the history, so the user can undo an AI write.
    expect(transactions[0].getMeta("preventUpdate")).toBe(true);
    expect(transactions[0].getMeta("addToHistory")).toBe(true);
    // Flushed AFTER the load: the flusher saw the new document.
    expect(flushes).toEqual(["new document"]);
    editor.commands.undo();
    expect(editor.getText()).toBe("old document");
  });

  it("handles an empty document", () => {
    goLive("tab-live");

    expect(loadIntoLiveWysiwyg("tab-live", "")).toBe(true);

    expect(editor.getText()).toBe("");
  });

  it("leaves the live editor alone when it is showing a different tab", () => {
    goLive("tab-live");

    expect(loadIntoLiveWysiwyg("tab-background", "new document\n")).toBe(false);

    // Dispatching here would have replaced the ACTIVE tab's document.
    expect(editor.getText()).toBe("old document");
    expect(transactions).toEqual([]);
    expect(flushes).toEqual([]);
  });

  it("does nothing when no WYSIWYG editor is mounted", () => {
    expect(loadIntoLiveWysiwyg("tab-live", "new document\n")).toBe(false);
    expect(transactions).toEqual([]);
  });

  it("does not flush when the editor refuses the content", () => {
    goLive("tab-live");
    vi.spyOn(editor.view, "dispatch").mockImplementation(() => {
      throw new RangeError("content does not fit the schema");
    });

    expect(loadIntoLiveWysiwyg("tab-live", "new document\n")).toBe(false);

    // The editor still holds the OLD document; a flush now would write it
    // over the content the handler has just put in the store.
    expect(flushes).toEqual([]);
  });
});

describe("while an IME composition is in progress in the live editor", () => {
  beforeEach(() => {
    goLive("tab-live");
    vi.spyOn(editor.view, "composing", "get").mockReturnValue(true);
  });

  it("refuses a write to the tab it is showing with BUSY", () => {
    expect(liveCompositionRefusal("tab-live")).toMatchObject({ error: "BUSY" });
  });

  it("does not refuse a write to a tab it is not showing", () => {
    expect(liveCompositionRefusal("tab-background")).toBeNull();
  });

  it("throws on a load that did not ask first, leaving the editor untouched", () => {
    expect(() => loadIntoLiveWysiwyg("tab-live", "new document\n")).toThrow(/composition/);
    expect(editor.getText()).toBe("old document");
    expect(transactions).toEqual([]);
    expect(flushes).toEqual([]);
  });
});

describe("liveCompositionRefusal with nobody composing", () => {
  it("lets the write go ahead", () => {
    goLive("tab-live");
    expect(liveCompositionRefusal("tab-live")).toBeNull();
  });

  it("lets the write go ahead when no editor is mounted", () => {
    expect(liveCompositionRefusal("tab-live")).toBeNull();
  });
});

describe("flushLiveEditors", () => {
  it("runs every mounted editor's flusher, not only the active one", () => {
    const seen: string[] = [];
    registerWysiwygFlusher("tab-a", () => seen.push("a"));
    registerWysiwygFlusher("tab-b", () => seen.push("b"));

    flushLiveEditors();

    registerWysiwygFlusher("tab-a", null);
    registerWysiwygFlusher("tab-b", null);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("is a no-op when nothing is mounted", () => {
    expect(() => flushLiveEditors()).not.toThrow();
  });
});
