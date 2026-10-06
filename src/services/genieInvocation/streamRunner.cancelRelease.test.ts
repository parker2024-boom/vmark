// WI-RA20.6 — cancelling a genie releases its `ai:response` listener at once.
// The handler ignores frames for a request that is no longer active, so after
// a cancel nothing ever released the listener: it stayed registered until the
// hook's own cancel or unmount. Tauri `invoke`/`listen` and sonner are the
// mocked boundary; the stores and the runner run real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useAiInvocationStore, useAiProviderStore } from "@/stores/aiStore";
import { useEditorStore } from "@/stores/editorStore";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { setCurrentWindowLabel } from "@/services/persistence/workspaceStorage";
import { cancelActiveInvocation } from "./cancelRequest";
import { runGenieStream } from "./streamRunner";

type ChunkHandler = (event: { payload: Record<string, unknown> }) => void;

/** Every registered `ai:response` listener, live until its unlisten runs. */
const bridge = vi.hoisted(() => ({
  live: new Map<number, ChunkHandler>(),
  nextId: 0,
  unlistenCalls: 0,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: ChunkHandler) => {
    const id = bridge.nextId++;
    bridge.live.set(id, handler);
    return Promise.resolve(() => {
      bridge.unlistenCalls++;
      bridge.live.delete(id);
    });
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const TAB = "tab-origin";
let editor: Editor | null = null;

function emit(requestId: string, payload: Record<string, unknown>) {
  for (const handler of [...bridge.live.values()]) {
    handler({ payload: { requestId, chunk: "", done: false, ...payload } });
  }
}

async function start(): Promise<{ ref: { current: UnlistenFn | null }; requestId: string }> {
  const ref: { current: UnlistenFn | null } = { current: null };
  await runGenieStream({
    filledPrompt: "Fix this: hello",
    extraction: { text: "hello", from: 1, to: 6 },
    processingLabel: "Fix",
    action: "replace",
    listenerRef: ref,
  });
  const requestId = useAiInvocationStore.getState().requestId;
  if (!requestId) throw new Error("no invocation running");
  return { ref, requestId };
}

beforeEach(() => {
  bridge.live.clear();
  bridge.unlistenCalls = 0;
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  useAiInvocationStore.getState().cancel();
  useDocumentStore.setState({ documents: {} });
  setCurrentWindowLabel("main");
  useTabStore.setState({ activeTabId: { main: TAB } });
  useAiProviderStore.setState({
    activeProvider: "openai",
    cliProviders: [],
    restProviders: [{ type: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4" }],
  });
  editor = new Editor({ extensions: [StarterKit], content: "<p>hello world</p>" });
  useEditorStore.getState().setTiptapEditor(editor);
  useEditorStore.getState().setActiveWysiwygEditor(editor, TAB);
});

afterEach(() => {
  useAiInvocationStore.getState().cancel();
  useEditorStore.getState().clearTiptap();
  editor?.destroy();
  editor = null;
});

describe("ai:response listener on cancel", () => {
  it("is released by the cancel itself, with no frame needed", async () => {
    const { ref } = await start();
    expect(bridge.live.size).toBe(1);

    cancelActiveInvocation();

    expect(bridge.live.size).toBe(0);
    expect(ref.current).toBeNull();
  });

  it("stays released when a late frame for the cancelled request arrives", async () => {
    const { requestId } = await start();
    cancelActiveInvocation();
    emit(requestId, { chunk: "late", done: true });

    expect(bridge.live.size).toBe(0);
    expect(editor?.getText()).toBe("hello world");
  });

  it("leaves the next run's listener alone when the old one is released", async () => {
    await start();
    cancelActiveInvocation();
    const next = await start();

    expect(bridge.live.size).toBe(1);
    expect(next.ref.current).not.toBeNull();
  });

  it("is released once when the stream completes normally", async () => {
    const { requestId, ref } = await start();
    emit(requestId, { chunk: "hi", done: true });

    expect(bridge.live.size).toBe(0);
    expect(ref.current).toBeNull();
  });

  it("is released when a run is cancelled repeatedly, and only once", async () => {
    await start();
    cancelActiveInvocation();
    cancelActiveInvocation();
    expect(bridge.live.size).toBe(0);
    expect(bridge.unlistenCalls).toBe(1);
  });

  it("is not unlistened a second time after the hook already released it", async () => {
    const { ref } = await start();
    // useGenieInvocation's cancel: unlisten through the shared ref, clear it,
    // then cancel the invocation.
    void ref.current?.();
    ref.current = null;
    cancelActiveInvocation();

    expect(bridge.live.size).toBe(0);
    expect(bridge.unlistenCalls).toBe(1);
  });
});
