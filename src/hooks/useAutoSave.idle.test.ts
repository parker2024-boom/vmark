// WI-RA10B.7 — an idle auto-save tick does not serialize the WYSIWYG document;
// a tick after an edit does, and dirty documents are saved either way.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/contexts/WindowContext", () => ({ useWindowLabel: vi.fn(() => "main") }));
vi.mock("@/services/persistence/saveToPath", () => ({ saveToPath: vi.fn() }));
vi.mock("@/utils/reentryGuard", () => ({ isOperationInProgress: vi.fn(() => false) }));
vi.mock("@/utils/debug", () => ({ autoSaveLog: vi.fn(), saveError: vi.fn() }));

import { useAutoSave } from "./useAutoSave";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { saveToPath } from "@/services/persistence/saveToPath";
// The real registries: the flusher below stands in for the editor's serialize.
import { registerActiveWysiwygFlusher } from "@/utils/wysiwygFlush";
import { setWysiwygEditPending } from "@/utils/wysiwygEditPending";

type Doc = ReturnType<typeof useDocumentStore.getState>["documents"][string];

const editor = {};

/** Put the tab's document into the real store with the given fields. */
function setDocument(fields: { isDirty: boolean; content: string }): void {
  const doc = { filePath: "/tmp/doc.md", isMissing: false, isDivergent: false, ...fields } as unknown as Doc;
  useDocumentStore.setState({ documents: { "tab-1": doc } });
}

/** The editor's flush: serializes, writes the edit to the store, clears its flag. */
const serialize = vi.fn(() => {
  setDocument({ isDirty: true, content: "Hello, edited" });
  setWysiwygEditPending(editor, false);
});

const tick = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setDocument({ isDirty: false, content: "Hello" });
  setWysiwygEditPending(editor, false);
  registerActiveWysiwygFlusher(serialize);
  useTabStore.setState({ tabs: { main: [{ id: "tab-1" }] } } as unknown as Parameters<typeof useTabStore.setState>[0]);
  useSettingsStore.setState({
    general: { ...useSettingsStore.getState().general, autoSaveEnabled: true, autoSaveInterval: 1 },
  });
  vi.mocked(saveToPath).mockResolvedValue(true);
});

afterEach(() => {
  registerActiveWysiwygFlusher(null);
  vi.useRealTimers();
});

describe("useAutoSave — idle ticks", () => {
  it("does not serialize the document while nothing has been typed", async () => {
    renderHook(() => useAutoSave());
    for (let i = 0; i < 5; i += 1) await tick();

    expect(serialize).not.toHaveBeenCalled();
    expect(saveToPath).not.toHaveBeenCalled();
  });

  it("serializes and saves on the tick after an edit, then goes idle again", async () => {
    renderHook(() => useAutoSave());
    await tick();
    expect(serialize).not.toHaveBeenCalled();

    setWysiwygEditPending(editor, true);
    await tick();
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(saveToPath).toHaveBeenCalledWith("tab-1", "/tmp/doc.md", "Hello, edited", "auto");

    setDocument({ isDirty: false, content: "Hello, edited" });
    for (let i = 0; i < 8; i += 1) await tick();
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(saveToPath).toHaveBeenCalledTimes(1);
  });

  it("still saves a document that is already dirty when no edit is pending", async () => {
    // Dirt that reached the store by another route: Source mode, or an edit the
    // editor's own debounce already flushed.
    setDocument({ isDirty: true, content: "Hello" });
    renderHook(() => useAutoSave());
    await tick();

    expect(serialize).not.toHaveBeenCalled();
    expect(saveToPath).toHaveBeenCalledWith("tab-1", "/tmp/doc.md", "Hello", "auto");
  });
});
