// @vitest-environment node
// WI-RA10A.2 — a disk change that arrives while the user is composing with an
// IME in the tab it concerns is decided after the composition, not during it.
/**
 * Deciding means flushing the editor and, for a clean document, reloading it.
 * Mid-composition the flush writes the uncommitted preedit text ("nihao") into
 * the store as if it were typing, and the reload replaces the document under
 * the composition the browser is still editing. The policy now waits for the
 * composition to end, its cleanup to run and the grace period to pass.
 *
 * The live editor is modelled as what this module sees of it: an entry in the
 * editor store whose view reports `composing`, and a flusher in the WYSIWYG
 * flush registry. The composition bookkeeping in `utils/imeGuard` is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const toastInfo = vi.fn();
vi.mock("@/services/ime/imeToast", () => ({
  imeToast: { info: (...args: unknown[]) => toastInfo(...args) },
}));
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import { useDocumentStore } from "@/stores/documentStore";
import { useEditorStore } from "@/stores/editorStore";
import { registerWysiwygFlusher } from "@/utils/wysiwygFlush";
import {
  flushProseMirrorCompositionQueue,
  IME_GRACE_PERIOD_MS,
  markProseMirrorCompositionEnd,
} from "@/utils/imeGuard";
import type { EditorView } from "@tiptap/pm/view";
import { applyModifyPolicy } from "./applyModifyPolicy";

const TAB = "tab-composing";
const OTHER_TAB = "tab-elsewhere";
const PATH = "/watched/doc.md";

interface StubView {
  composing: boolean;
  isDestroyed: boolean;
}

const doc = (tabId = TAB) => useDocumentStore.getState().documents[tabId];

function seed(tabId: string, raw: string, path = PATH) {
  useDocumentStore.getState().ingestExternalContent(tabId, raw, "disk-open", { filePath: path });
}

/** Mount a live WYSIWYG editor for `tabId` whose view is mid-composition. */
function composeIn(tabId: string): StubView {
  const view: StubView = { composing: true, isDestroyed: false };
  useEditorStore.getState().setActiveWysiwygEditor({ view } as never, tabId);
  return view;
}

/** What the composition guard does when the composition ends: mark, clean up, flush. */
function endComposition(view: StubView) {
  view.composing = false;
  markProseMirrorCompositionEnd(view as unknown as EditorView);
  flushProseMirrorCompositionQueue(view as unknown as EditorView);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  // The fake clock starts at 0, which the grace-period bookkeeping reads as
  // "no composition has ended".
  vi.advanceTimersByTime(10_000);
  useDocumentStore.setState({ documents: {} });
  useEditorStore.getState().clearActiveEditors();
  registerWysiwygFlusher(TAB, null);
  toastInfo.mockReset();
});

afterEach(() => {
  useEditorStore.getState().clearActiveEditors();
  registerWysiwygFlusher(TAB, null);
  vi.useRealTimers();
});

describe("a disk change while the tab is mid-composition", () => {
  it("neither flushes nor reloads until the composition has settled", () => {
    seed(TAB, "alpha\n");
    const view = composeIn(TAB);
    const flusher = vi.fn();
    registerWysiwygFlusher(TAB, flusher);
    const queueDirtyChange = vi.fn();

    applyModifyPolicy(TAB, PATH, "alpha\nformatted on disk\n", queueDirtyChange);

    expect(flusher).not.toHaveBeenCalled();
    expect(doc()?.content).toBe("alpha\n");
    expect(toastInfo).not.toHaveBeenCalled();

    endComposition(view);
    expect(doc()?.content).toBe("alpha\n");

    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);
    expect(flusher).toHaveBeenCalled();
    expect(doc()?.content).toBe("alpha\nformatted on disk\n");
    expect(toastInfo).toHaveBeenCalledExactlyOnceWith("dialog:toast.reloaded");
    expect(queueDirtyChange).not.toHaveBeenCalled();
  });

  it("decides on the committed text, so a composition that was typed is a conflict", () => {
    seed(TAB, "alpha\n");
    const view = composeIn(TAB);
    // What the editor holds once the composition is committed.
    let pending: string | null = "alpha\n你好\n";
    registerWysiwygFlusher(TAB, () => {
      if (pending === null) return;
      useDocumentStore.getState().setEditorContent(TAB, pending, { fromUserEdit: true });
      pending = null;
    });
    const queueDirtyChange = vi.fn();

    applyModifyPolicy(TAB, PATH, "alpha\nformatted on disk\n", queueDirtyChange);
    endComposition(view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(queueDirtyChange).toHaveBeenCalledExactlyOnceWith(TAB, PATH);
    expect(doc()?.content).toBe("alpha\n你好\n");
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("handles several disk changes in the order they arrived", () => {
    seed(TAB, "alpha\n");
    const view = composeIn(TAB);
    registerWysiwygFlusher(TAB, () => {});

    applyModifyPolicy(TAB, PATH, "alpha\nfirst\n", vi.fn());
    applyModifyPolicy(TAB, PATH, "alpha\nsecond\n", vi.fn());
    endComposition(view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(doc()?.content).toBe("alpha\nsecond\n");
  });

  it("still restores a reappeared file, after the composition", () => {
    seed(TAB, "alpha\n");
    useDocumentStore.getState().markMissing(TAB);
    const view = composeIn(TAB);

    applyModifyPolicy(TAB, PATH, "alpha\n", vi.fn());
    expect(doc()?.isMissing).toBe(true);

    endComposition(view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(doc()?.isMissing).toBe(false);
    expect(toastInfo).toHaveBeenCalledExactlyOnceWith("dialog:toast.restored");
  });

  it("is dropped if the tab is closed before the composition settles", () => {
    seed(TAB, "alpha\n");
    const view = composeIn(TAB);
    const queueDirtyChange = vi.fn();

    applyModifyPolicy(TAB, PATH, "alpha\nformatted on disk\n", queueDirtyChange);
    useDocumentStore.getState().removeDocument(TAB);
    endComposition(view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(doc()).toBeUndefined();
    expect(queueDirtyChange).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe("what does not wait", () => {
  it("our own save echoing back is settled at once, composition or not", () => {
    seed(TAB, "alpha\nbeta\n");
    composeIn(TAB);
    const flusher = vi.fn();
    registerWysiwygFlusher(TAB, flusher);

    applyModifyPolicy(TAB, PATH, "alpha\r\nbeta\r\n", vi.fn());

    // The line-ending refresh touches the store only, never the editor.
    expect(doc()?.lastDiskContent).toBe("alpha\r\nbeta\r\n");
    expect(flusher).not.toHaveBeenCalled();
  });

  it("a change to a tab other than the one being composed in", () => {
    seed(OTHER_TAB, "other\n", "/watched/other.md");
    composeIn(TAB);

    applyModifyPolicy(OTHER_TAB, "/watched/other.md", "other\nchanged\n", vi.fn());

    expect(doc(OTHER_TAB)?.content).toBe("other\nchanged\n");
  });

  it("a change to a tab whose editor is not composing", () => {
    seed(TAB, "alpha\n");
    const view = composeIn(TAB);
    view.composing = false;

    applyModifyPolicy(TAB, PATH, "alpha\nchanged\n", vi.fn());

    expect(doc()?.content).toBe("alpha\nchanged\n");
  });

  it("a change to a tab with no live editor", () => {
    seed(TAB, "alpha\n");

    applyModifyPolicy(TAB, PATH, "alpha\nchanged\n", vi.fn());

    expect(doc()?.content).toBe("alpha\nchanged\n");
  });
});
