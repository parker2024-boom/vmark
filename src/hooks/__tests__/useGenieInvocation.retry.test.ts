/**
 * WI-RA19.3 — the status bar's Retry re-runs the invocation that failed.
 *
 * It used to only dismiss the error, so the button labelled "Retry" did the
 * same thing as the × beside it. These tests drive a real failure through the
 * hook (error frame, rejected dispatch) and assert that retrying through the
 * store alone dispatches the same prompt again — after the picker that
 * started it has closed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { GenieDefinition } from "@/types/aiGenies";

type ChunkListener = (event: { payload: Record<string, unknown> }) => void;
let listenCallback: ChunkListener | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_eventName: string, cb: ChunkListener) => {
    listenCallback = cb;
    return Promise.resolve(vi.fn());
  }),
}));

const mockInvoke = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock("@/services/editor/sourcePeek", () => ({
  getExpandedSourcePeekRange: vi.fn(() => ({ from: 0, to: 5 })),
  serializeSourcePeekRange: vi.fn(() => "hello"),
}));

vi.mock("@/services/editor/extractContext", () => ({
  extractSurroundingContext: vi.fn(() => ({ before: "", after: "" })),
}));

vi.mock("@/utils/markdownPipeline", () => ({
  serializeMarkdown: vi.fn(() => "hello"),
}));

vi.mock("@/services/persistence/workspaceStorage", () => ({
  getCurrentWindowLabel: () => "main",
}));

import { useAiInvocationStore, useAiProviderStore, useGeniesStore } from "@/stores/aiStore";
import { useGeniePickerStore } from "@/stores/geniePickerStore";
import { useUIStore } from "@/stores/uiStore";
import { useEditorStore } from "@/stores/editorStore";
import { useTabStore } from "@/stores/tabStore";
import { useGenieInvocation } from "../useGenieInvocation";

function makeGenie(): GenieDefinition {
  return {
    metadata: { name: "Polish", scope: "selection", action: "replace" },
    template: "Polish this: {{content}}",
  } as GenieDefinition;
}

function installEditor() {
  const editor = {
    state: {
      doc: { content: { size: 5 } },
      selection: { from: 0, to: 5, empty: false },
      tr: {
        replaceRange: vi.fn().mockReturnThis(),
        scrollIntoView: vi.fn().mockReturnThis(),
        setMeta: vi.fn().mockReturnThis(),
      },
    },
    view: { dispatch: vi.fn() },
  };
  useEditorStore.setState((s) => ({ tiptap: { ...s.tiptap, editor: editor as never } }));
  useEditorStore.getState().setActiveWysiwygEditor(editor as never, "tab-1");
}

function promptCalls(): string[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "run_ai_prompt")
    .map(([, args]) => (args as { prompt: string }).prompt);
}

/** Deliver a provider error frame for the request currently running. */
function failCurrentRequest(message: string): void {
  const requestId = useAiInvocationStore.getState().requestId;
  act(() => {
    listenCallback?.({ payload: { requestId, error: message, chunk: "", done: false } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listenCallback = null;
  useAiInvocationStore.getState().cancel();
  useGeniePickerStore.setState({ isOpen: false, mode: "search", pickerError: null, responseText: "" });
  useUIStore.setState({ sourceMode: false });
  useTabStore.setState({ activeTabId: { main: "tab-1" } });
  useAiProviderStore.setState({
    activeProvider: "openai",
    restProviders: [
      { type: "openai", name: "OpenAI", apiKey: "sk-test", model: "gpt-4", endpoint: null } as never,
    ],
    ensureProvider: vi.fn(async () => true),
  } as never);
  installEditor();
});

describe("Retry after a failed genie run", () => {
  it("re-dispatches the same genie prompt after the picker has closed", async () => {
    const { result } = renderHook(() => useGenieInvocation());
    await act(async () => {
      await result.current.invokeGenie(makeGenie());
    });
    failCurrentRequest("Provider timeout");
    useGeniePickerStore.getState().closePicker();
    expect(useAiInvocationStore.getState().error).toBe("Provider timeout");

    await act(async () => {
      useAiInvocationStore.getState().retryFailed();
    });

    await vi.waitFor(() => expect(promptCalls()).toHaveLength(2));
    const [first, second] = promptCalls();
    expect(second).toBe(first);
    expect(first).toContain("Polish this: hello");
    expect(useAiInvocationStore.getState().error).toBeNull();
    expect(useAiInvocationStore.getState().isRunning).toBe(true);
    expect(useGeniesStore.getState().recentGenieNames[0]).toBe("Polish");
  });

  it("re-dispatches a freeform prompt with its original instruction", async () => {
    const { result } = renderHook(() => useGenieInvocation());
    await act(async () => {
      await result.current.invokeFreeform("make it shorter", "selection");
    });
    failCurrentRequest("rate limited");

    await act(async () => {
      useAiInvocationStore.getState().retryFailed();
    });

    await vi.waitFor(() => expect(promptCalls()).toHaveLength(2));
    expect(promptCalls()[1]).toBe(promptCalls()[0]);
    expect(promptCalls()[1]).toContain("make it shorter");
  });

  it("re-dispatches after the dispatch itself was rejected", async () => {
    mockInvoke.mockImplementationOnce(() => Promise.reject(new Error("spawn failed")));
    const { result } = renderHook(() => useGenieInvocation());
    await act(async () => {
      await result.current.invokeGenie(makeGenie());
    });
    expect(useAiInvocationStore.getState().error).toBe("spawn failed");

    await act(async () => {
      useAiInvocationStore.getState().retryFailed();
    });

    await vi.waitFor(() => expect(promptCalls()).toHaveLength(2));
  });

  it("retries the request that failed, not an earlier one that succeeded", async () => {
    const { result } = renderHook(() => useGenieInvocation());
    await act(async () => {
      await result.current.invokeFreeform("first instruction", "selection");
    });
    useAiInvocationStore.getState().finish();
    await act(async () => {
      await result.current.invokeFreeform("second instruction", "selection");
    });
    failCurrentRequest("boom");

    await act(async () => {
      useAiInvocationStore.getState().retryFailed();
    });

    await vi.waitFor(() => expect(promptCalls()).toHaveLength(3));
    expect(promptCalls()[2]).toContain("second instruction");
  });
});
