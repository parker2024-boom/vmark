// @vitest-environment node
// WI-RA10A.1 — the external-change policy decides on what the user has TYPED,
// not on what the debounced editor flush has delivered to the store so far.
/**
 * A WYSIWYG editor holds the truth and the store trails it: keystrokes reach
 * the store on a debounced flush (a frame for small documents, seconds for
 * large ones). A formatter rewriting the file inside that window found the
 * store still clean, so the policy reloaded from disk and the keystrokes were
 * gone under a "Reloaded" toast.
 *
 * The editor is modelled as what it is to this module: a flusher registered in
 * the WYSIWYG flush registry that writes its pending edit into the store.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const toastInfo = vi.fn();
vi.mock("@/services/ime/imeToast", () => ({
  imeToast: { info: (...args: unknown[]) => toastInfo(...args) },
}));
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import { useDocumentStore } from "@/stores/documentStore";
import { registerWysiwygFlusher } from "@/utils/wysiwygFlush";
import { applyModifyPolicy } from "./applyModifyPolicy";

const TAB = "tab-policy";
const PATH = "/watched/doc.md";

const doc = () => useDocumentStore.getState().documents[TAB];

function seed(raw: string) {
  useDocumentStore.getState().ingestExternalContent(TAB, raw, "disk-open", { filePath: PATH });
}

/**
 * Model a live editor holding an edit the store has not seen yet. The flusher
 * consumes the edit, as the real one does, so a second flush is a no-op.
 */
function typeWithoutFlushing(text: string) {
  let pending: string | null = text;
  registerWysiwygFlusher(TAB, () => {
    if (pending === null) return;
    const edit = pending;
    pending = null;
    useDocumentStore.getState().setEditorContent(TAB, edit, { fromUserEdit: true });
  });
}

beforeEach(() => {
  useDocumentStore.setState({ documents: {} });
  registerWysiwygFlusher(TAB, null);
  toastInfo.mockReset();
});

describe("applyModifyPolicy flushes the editor before it reads the dirty flag", () => {
  it("takes the dirty branch when the only edit is still un-flushed", () => {
    seed("alpha\n");
    typeWithoutFlushing("alpha\ntyped but not flushed\n");
    const queueDirtyChange = vi.fn();

    applyModifyPolicy(TAB, PATH, "alpha\nformatted on disk\n", queueDirtyChange);

    expect(queueDirtyChange).toHaveBeenCalledExactlyOnceWith(TAB, PATH);
    expect(doc()?.content).toBe("alpha\ntyped but not flushed\n");
    expect(doc()?.isDirty).toBe(true);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("keeps un-flushed typing when a deleted file reappears", () => {
    seed("alpha\n");
    useDocumentStore.getState().markMissing(TAB);
    typeWithoutFlushing("alpha\nrescued\n");
    const queueDirtyChange = vi.fn();

    applyModifyPolicy(TAB, PATH, "alpha\nrecreated\n", queueDirtyChange);

    expect(queueDirtyChange).toHaveBeenCalledExactlyOnceWith(TAB, PATH);
    expect(doc()?.content).toBe("alpha\nrescued\n");
    expect(doc()?.isMissing).toBe(true);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("un-diverges against the typed text, not the stale store text", () => {
    seed("alpha\n");
    useDocumentStore.getState().markDivergent(TAB);
    // The user typed exactly what the disk now holds; the store has not heard.
    typeWithoutFlushing("alpha\nbeta\n");
    const queueDirtyChange = vi.fn();

    applyModifyPolicy(TAB, PATH, "alpha\nbeta\n", queueDirtyChange);

    expect(queueDirtyChange).not.toHaveBeenCalled();
    expect(doc()?.isDivergent).toBe(false);
    expect(doc()?.isDirty).toBe(false);
    expect(doc()?.content).toBe("alpha\nbeta\n");
    // Nothing was reloaded: the editor already showed this text.
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("still reloads a clean document whose editor has nothing pending", () => {
    seed("alpha\n");
    // A mounted editor with no pending edit: its flush changes nothing.
    registerWysiwygFlusher(TAB, () => {});
    const queueDirtyChange = vi.fn();

    applyModifyPolicy(TAB, PATH, "alpha\nformatted on disk\n", queueDirtyChange);

    expect(queueDirtyChange).not.toHaveBeenCalled();
    expect(doc()?.content).toBe("alpha\nformatted on disk\n");
    expect(doc()?.isDirty).toBe(false);
    expect(toastInfo).toHaveBeenCalledExactlyOnceWith("dialog:toast.reloaded");
  });

  it("does not flush for a rewrite that changed nothing but the line endings", () => {
    seed("alpha\nbeta\n");
    const flusher = vi.fn();
    registerWysiwygFlusher(TAB, flusher);

    applyModifyPolicy(TAB, PATH, "alpha\r\nbeta\r\n", vi.fn());

    // The flush is the cost of DECIDING, and it serializes the whole document.
    // A sync daemon touching only the line endings needs no decision.
    expect(flusher).not.toHaveBeenCalled();
    expect(doc()?.lastDiskContent).toBe("alpha\r\nbeta\r\n");
  });

  it("a flusher that throws does not stop the policy", () => {
    seed("alpha\n");
    registerWysiwygFlusher(TAB, () => {
      throw new Error("editor torn down mid-flush");
    });
    const queueDirtyChange = vi.fn();

    expect(() =>
      applyModifyPolicy(TAB, PATH, "alpha\nformatted on disk\n", queueDirtyChange),
    ).not.toThrow();
    expect(doc()?.content).toBe("alpha\nformatted on disk\n");
  });

  it("does nothing for a tab that has no document", () => {
    const flusher = vi.fn();
    registerWysiwygFlusher(TAB, flusher);
    const queueDirtyChange = vi.fn();

    applyModifyPolicy("no-such-tab", PATH, "alpha\n", queueDirtyChange);

    expect(queueDirtyChange).not.toHaveBeenCalled();
    expect(flusher).not.toHaveBeenCalled();
  });
});
