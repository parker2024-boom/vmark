// WI-RA18.2 — an MCP write into the editor the user is composing in (an IME
// composition in progress, or just ended and not yet cleaned up) is refused
// with BUSY and changes nothing: not the editor, not the store, not the
// revision. Reads are not refused, and a write to a tab the composing editor
// is not showing goes ahead.
//
// A real Tiptap editor, a real CodeMirror view, the real editor store and the
// real composition bookkeeping in utils/imeGuard; only the reply channel, the
// window label and checkpoint persistence are stubbed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState as CMState } from "@codemirror/state";
import { EditorView as CMView } from "@codemirror/view";

import { useTabStore } from "@/stores/tabStore";
import type { DocumentTab } from "@/stores/tabStoreTypes";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { useUIStore } from "@/stores/uiStore";
import { useEditorStore } from "@/stores/editorStore";
import { useMcpStore } from "@/stores/mcpStore";
import {
  IME_GRACE_PERIOD_MS,
  markCodeMirrorCompositionEnd,
  markProseMirrorCompositionEnd,
} from "@/utils/imeGuard";
import { handleDocumentTransform, handleDocumentWrite } from "@/services/mcpBridge/v2/document";
import { handleSelectionGet, handleSelectionSet } from "@/services/mcpBridge/v2/selection";

vi.mock("@/services/mcpBridge/utils", () => ({
  respond: vi.fn(),
}));

vi.mock("@/services/persistence/workspaceStorage", () => ({
  getCurrentWindowLabel: () => "main",
}));

import { respond } from "@/services/mcpBridge/utils";

let editor: Editor | null = null;
let cmView: CMView | null = null;
let cmParent: HTMLElement | null = null;

function untitledTab(id: string, title: string): DocumentTab {
  return { kind: "document", id, filePath: null, title, isPinned: false, formatId: "markdown" };
}

/** Two tabs in the main window; `focused` is the active one. */
function seedTabs(focused: string): void {
  useTabStore.setState({
    tabs: {
      main: [
        untitledTab("t-live", "live"),
        untitledTab("t-other", "other"),
      ],
    },
    activeTabId: { main: focused },
    untitledCounter: 0,
  });
  useDocumentStore.getState().initDocument("t-live", "old document\n", null);
  useDocumentStore.getState().initDocument("t-other", "other document\n", null);
}

/** Mount a WYSIWYG editor as the live editor showing `t-live`. */
function mountWysiwyg(): Editor {
  editor = new Editor({ extensions: [StarterKit], content: "<p>old document</p>" });
  editor.commands.setTextSelection({ from: 1, to: 4 });
  useEditorStore.getState().setTiptapEditor(editor);
  useEditorStore.getState().setActiveWysiwygEditor(editor, "t-live");
  return editor;
}

/** Mount a Source editor as the live editor showing `t-live`. */
function mountSource(): CMView {
  cmParent = document.createElement("div");
  document.body.appendChild(cmParent);
  cmView = new CMView({
    state: CMState.create({ doc: "old document\n", selection: { anchor: 0, head: 3 } }),
    parent: cmParent,
  });
  useUIStore.setState({ sourceMode: true });
  useEditorStore.getState().setActiveSourceView(cmView, "t-live");
  return cmView;
}

/** The composition is still in progress. */
function composeIn(view: { composing: boolean }): void {
  vi.spyOn(view, "composing", "get").mockReturnValue(true);
}

function lastRespond() {
  const calls = vi.mocked(respond).mock.calls;
  return calls[calls.length - 1][0];
}

function refusalOf(reply: { success: boolean; error?: string }): { error: string; message: string } {
  expect(reply.success).toBe(false);
  return JSON.parse(reply.error ?? "null");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["performance", "Date"] });
  vi.advanceTimersByTime(10_000);
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
  useMcpStore.setState((s) => ({ checkpoint: { ...s.checkpoint, checkpoints: [], hydrated: false } }));
  useUIStore.setState({ sourceMode: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useEditorStore.getState().setActiveWysiwygEditor(null);
  useEditorStore.getState().setTiptapEditor(null);
  useEditorStore.getState().setActiveSourceView(null);
  editor?.destroy();
  editor = null;
  cmView?.destroy();
  cmView = null;
  cmParent?.remove();
  cmParent = null;
});

describe("vmark.document.write into the composing WYSIWYG editor", () => {
  it("is refused with BUSY while the composition is in progress, and changes nothing", async () => {
    seedTabs("t-live");
    const live = mountWysiwyg();
    composeIn(live.view);
    const revisionBefore = useRevisionStore.getState().getRevision("t-live");

    await handleDocumentWrite("req-1", { content: "AI text\n", save: false });

    expect(refusalOf(lastRespond())).toMatchObject({ error: "BUSY" });
    expect(live.getText()).toBe("old document");
    expect(useDocumentStore.getState().documents["t-live"].content).toBe("old document\n");
    expect(useDocumentStore.getState().documents["t-live"].isDirty).toBe(false);
    expect(useRevisionStore.getState().getRevision("t-live")).toBe(revisionBefore);
    expect(useMcpStore.getState().checkpoint.checkpoints).toEqual([]);
  });

  it("is refused through the grace period after the composition ends, then goes ahead", async () => {
    seedTabs("t-live");
    const live = mountWysiwyg();
    markProseMirrorCompositionEnd(live.view);

    await handleDocumentWrite("req-2", { content: "AI text\n", save: false });
    expect(refusalOf(lastRespond())).toMatchObject({ error: "BUSY" });
    expect(live.getText()).toBe("old document");

    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);
    await handleDocumentWrite("req-3", { content: "AI text\n", save: false });
    expect(lastRespond().success).toBe(true);
    expect(live.getText()).toBe("AI text");
  });

  it("goes ahead for a tab the composing editor is not showing", async () => {
    seedTabs("t-live");
    const live = mountWysiwyg();
    composeIn(live.view);

    await handleDocumentWrite("req-4", { tabId: "t-other", content: "AI text\n", save: false });

    expect(lastRespond().success).toBe(true);
    expect(useDocumentStore.getState().documents["t-other"].content).toBe("AI text\n");
    expect(live.getText()).toBe("old document");
  });
});

describe("vmark.document.transform on the composing WYSIWYG editor", () => {
  it("is refused with BUSY and changes nothing", async () => {
    seedTabs("t-live");
    useDocumentStore.getState().initDocument("t-live", "中文English\n", null);
    const live = mountWysiwyg();
    composeIn(live.view);

    await handleDocumentTransform("req-5", { kind: "cjk-spacing" });

    expect(refusalOf(lastRespond())).toMatchObject({ error: "BUSY" });
    expect(useDocumentStore.getState().documents["t-live"].content).toBe("中文English\n");
    expect(live.getText()).toBe("old document");
  });
});

describe("vmark.selection.set into a composing editor", () => {
  it("is refused with BUSY in WYSIWYG and leaves the selection's text alone", async () => {
    seedTabs("t-live");
    const live = mountWysiwyg();
    composeIn(live.view);
    const revisionBefore = useRevisionStore.getState().getRevision("t-live");

    await handleSelectionSet("req-6", { content: "AI" });

    expect(refusalOf(lastRespond())).toMatchObject({ error: "BUSY" });
    expect(live.getText()).toBe("old document");
    expect(useRevisionStore.getState().getRevision("t-live")).toBe(revisionBefore);
  });

  it("is refused with BUSY in Source mode through the grace period", async () => {
    seedTabs("t-live");
    const view = mountSource();
    markCodeMirrorCompositionEnd(view);

    await handleSelectionSet("req-7", { content: "AI" });

    expect(refusalOf(lastRespond())).toMatchObject({ error: "BUSY" });
    expect(view.state.doc.toString()).toBe("old document\n");
  });

  it("is refused with BUSY in Source mode while composing", async () => {
    seedTabs("t-live");
    const view = mountSource();
    composeIn(view);

    await handleSelectionSet("req-8", { content: "AI" });

    expect(refusalOf(lastRespond())).toMatchObject({ error: "BUSY" });
    expect(view.state.doc.toString()).toBe("old document\n");
  });

  it("goes ahead once the composition has settled", async () => {
    seedTabs("t-live");
    const live = mountWysiwyg();
    markProseMirrorCompositionEnd(live.view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    await handleSelectionSet("req-9", { content: "AI" });

    expect(lastRespond().success).toBe(true);
    expect(live.getText()).toBe("AI document");
  });
});

describe("vmark.selection.get while composing", () => {
  it("is not refused: reading changes nothing", async () => {
    seedTabs("t-live");
    const live = mountWysiwyg();
    composeIn(live.view);

    await handleSelectionGet("req-10", {});

    expect(lastRespond().success).toBe(true);
    expect(lastRespond().data).toMatchObject({ text: "old" });
  });
});
