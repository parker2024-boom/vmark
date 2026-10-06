// WI-RA14C.5 — the AI genie flow, end to end: a genie picked on a selection →
// `run_ai_prompt` receives the filled prompt and a request id → the answer
// streams into the picker → the done frame leaves a SUGGESTION and an
// untouched document → Accept writes the AI's text, Reject writes nothing.
//
// REAL: the genie picker component and its command, `useGenieInvocation`, the
// stream runner, the AI / picker / tab / document / settings stores, and the
// production WYSIWYG editor (production extensions including the aiSuggestion
// plugin, the flush machinery, the save pipeline) on a document opened through
// the real open path.
// FAKED: `@tauri-apps/*` only — the stateful in-memory disk with NAMED command
// stubs behind `invoke` (an unstubbed command rejects), a handler registry
// behind `listen` — plus sonner, the toast renderer.
// Left to the real-app journey (e2e/journeys/43-ai-genies.mjs): the Rust
// provider stack behind `run_ai_prompt` and the frames it emits.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";

type FrameHandler = (frame: { payload: Record<string, unknown> }) => void;

const bridge = vi.hoisted(() => ({ handlers: new Map<string, Set<(frame: never) => void>>() }));

vi.mock("@tauri-apps/plugin-fs", async () => (await import("@/test/statefulFsFake")).statefulFs.fsModule());
vi.mock("@tauri-apps/api/core", async () => (await import("@/test/statefulFsFake")).statefulFs.coreModule());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (frame: never) => void) => {
    const registered = bridge.handlers.get(event) ?? new Set();
    bridge.handlers.set(event, registered.add(handler));
    return Promise.resolve(() => void registered.delete(handler));
  }),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { WindowContext } from "@/contexts/WindowContext";
import { GeniePicker } from "@/components/GeniePicker/GeniePicker";
import { TiptapEditorInner } from "@/components/Editor/TiptapEditor";
import { useAiInvocationStore, useAiProviderStore, useAiSuggestionStore, useGeniesStore } from "@/stores/aiStore";
import { useGeniePickerStore } from "@/stores/geniePickerStore";
import { useEditorStore } from "@/stores/editorStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { executeCommand } from "@/services/commands/CommandBus";
import { registerGenieCommands } from "@/services/commands/genieCommands";
import { handleSave } from "@/services/files/fileSave";
import { bootstrapFormats } from "@/lib/formats/registryBootstrap";
import { flushActiveWysiwygNow } from "@/utils/wysiwygFlush";
import { statefulFs } from "@/test/statefulFsFake";
import { ROOT, WINDOW, doc, openDocInTab, resetTier0 } from "./harness";

const DOC = `${ROOT}/notes.md`;
const ORIGINAL = "hello world\n\n你好，世界。\n";
const OPENAI = { type: "openai" as const, name: "OpenAI", endpoint: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4" };
/** What `load_genies` answers: one selection-scoped prompt genie, content included. */
const GENIES = [{
  name: "polish", path: "/genies/polish.md", source: "global", category: "editing", kind: "markdown",
  content: { metadata: { name: "polish", description: "Improve clarity", scope: "selection" }, template: "Polish this:\n\n{{content}}" },
}];
/** jsdom has no layout; the editor's scroll-into-view only needs these to exist. */
const LAYOUT_STUBS = { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() };

/** Every Rust command the flow reached, in order. */
let calls: Array<{ cmd: string; args: Record<string, unknown> }>;
let tabId: string;
let editor: Editor;

function stub(cmd: string, answer: (args: Record<string, unknown>) => unknown): void {
  statefulFs.stubCommand(cmd, (args) => {
    calls.push({ cmd, args });
    return answer(args);
  });
}
const callsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

/** Let every pending frame, debounce and promise chain run. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

async function mountApp(content = ORIGINAL): Promise<void> {
  tabId = await openDocInTab(DOC, content);
  render(
    <WindowContext.Provider value={{ windowLabel: WINDOW, isDocumentWindow: true }}>
      <TiptapEditorInner />
      <GeniePicker />
    </WindowContext.Provider>,
  );
  await settle();
  const live = useEditorStore.getState().tiptap.editor;
  if (!live) throw new Error("the WYSIWYG editor did not register itself");
  editor = live;
}

/** Select `text` the way a drag does, then pick the genie in the picker. */
async function runGenieOn(text: string, clicks = 1): Promise<void> {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from === -1 && node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text);
  });
  if (from === -1) throw new Error(`"${text}" is not in the document`);
  act(() => void editor.commands.setTextSelection({ from, to: from + text.length }));
  await act(async () => {
    await executeCommand("genies.openPicker"); // what menu:search-genies is bound to
  });
  await settle();
  const row = screen.getByRole("option", { name: /Polish/ });
  act(() => {
    for (let i = 0; i < clicks; i++) fireEvent.click(row);
  });
  await settle();
}

const picker = () => screen.getByRole("dialog", { name: "AI Genies" });
const press = (name: string) => act(() => void fireEvent.click(within(picker()).getByRole("button", { name })));
const requestId = () => String(callsOf("run_ai_prompt").at(-1)?.requestId);
const streamHandlers = () => [...(bridge.handlers.get("ai:response") ?? [])] as FrameHandler[];
const suggestions = () => [...useAiSuggestionStore.getState().suggestions.values()];
const invocation = () => useAiInvocationStore.getState();

/** Deliver one `ai:response` frame for the running request to whoever listens. */
function stream(frame: Record<string, unknown>, to = streamHandlers()): void {
  const payload = { requestId: requestId(), chunk: "", done: false, ...frame };
  act(() => to.forEach((handler) => handler({ payload })));
}

/** The document as the store holds it once the editor has flushed. */
function storedDocument(): string {
  act(() => flushActiveWysiwygNow());
  return doc(tabId).content;
}

beforeAll(() => {
  bootstrapFormats();
  registerGenieCommands();
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  vi.clearAllMocks();
  bridge.handlers.clear();
  calls = [];
  useSettingsStore.getState().resetSettings();
  resetTier0();
  stub("load_genies", () => GENIES);
  stub("run_ai_prompt", () => undefined);
  stub("cancel_ai_prompt", () => undefined);
  useEditorStore.getState().clearTiptap();
  invocation().cancel();
  useAiSuggestionStore.setState({ suggestions: new Map(), focusedSuggestionId: null });
  useGeniePickerStore.getState().closePicker();
  useGeniesStore.setState({ genies: [], recentGenieNames: [] });
  useAiProviderStore.setState({ activeProvider: "openai", cliProviders: [], restProviders: [OPENAI] });
  for (const [name, value] of Object.entries(LAYOUT_STUBS)) {
    if (name in Range.prototype) throw new Error(`jsdom now defines ${name}; drop this stub`);
    Object.defineProperty(Range.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  cleanup();
  for (const name of Object.keys(LAYOUT_STUBS)) Reflect.deleteProperty(Range.prototype, name);
  vi.useRealTimers();
});

describe("a genie run on a selection", () => {
  it("sends the filled prompt, streams into the picker, and leaves a suggestion — not an edit", async () => {
    await mountApp();
    await runGenieOn("hello", 2); // a double click: still ONE request, ONE listener

    expect(streamHandlers()).toHaveLength(1);
    expect(callsOf("run_ai_prompt")).toEqual([{
      requestId: invocation().requestId,
      // The selection travels as serialized markdown, which ends in a newline.
      prompt: "Polish this:\n\nhello\n",
      provider: "openai", model: "gpt-4", apiKey: "sk-test", endpoint: "https://api.openai.com/v1", cliPath: null,
    }]);
    expect(requestId()).toMatch(/^[0-9a-f-]{36}$/);

    stream({ chunk: "How" });
    stream({ requestId: "someone-else", chunk: "NOPE" });
    stream({ chunk: "dy" });
    expect(within(picker()).getByText("Howdy")).toBeInTheDocument();
    stream({ done: true });

    expect(suggestions()).toEqual([expect.objectContaining({ tabId, type: "replace", from: 1, to: 6, newContent: "Howdy" })]);
    // Painted in the editor as ghost text, while the document itself is unchanged.
    expect(document.querySelector(".ProseMirror .ai-suggestion-ghost")?.textContent).toBe("Howdy");
    expect(within(picker()).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(storedDocument()).toBe(ORIGINAL);
    expect(doc(tabId).isDirty).toBe(false);
    expect(useGeniesStore.getState().recentGenieNames).toEqual(["polish"]);
  });

  it("Accept writes the AI's text into the editor, the document store and — on save — the file", async () => {
    await mountApp("\u{FEFF}hello world\r\n\r\nsecond\r\n");
    await runGenieOn("hello");
    stream({ chunk: "Howdy", done: true });

    press("Accept");

    expect(editor.getText()).toContain("Howdy world");
    expect(storedDocument()).toBe("Howdy world\n\nsecond\n");
    expect(doc(tabId).isDirty).toBe(true);
    expect(suggestions()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      await handleSave(WINDOW);
    });
    // The file keeps its own BOM and CRLF convention around the AI's text.
    expect(statefulFs.read(DOC)).toBe("\u{FEFF}Howdy world\r\n\r\nsecond\r\n");
  });

  it("Reject discards the suggestion and leaves the text untouched", async () => {
    await mountApp();
    await runGenieOn("世界");
    expect(callsOf("run_ai_prompt")[0].prompt).toBe("Polish this:\n\n世界\n");
    stream({ chunk: "宇宙", done: true });

    press("Reject");

    expect(suggestions()).toEqual([]);
    expect(document.querySelector(".ai-suggestion-ghost")).toBeNull();
    expect(storedDocument()).toBe(ORIGINAL);
    expect(doc(tabId).isDirty).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with auto-approve on, the answer is applied directly and no suggestion is left", async () => {
    const { mcpServer } = useSettingsStore.getState().advanced;
    useSettingsStore.getState().updateAdvancedSetting("mcpServer", { ...mcpServer, autoApproveEdits: true });
    await mountApp();
    await runGenieOn("世界");

    stream({ chunk: "  宇宙 ", done: true });

    expect(storedDocument()).toBe("hello world\n\n你好，宇宙。\n");
    expect(suggestions()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invocation().isRunning).toBe(false);
  });
});

describe("a genie run that does not finish", () => {
  it("Cancel reaches cancel_ai_prompt with the request id, and a late frame changes nothing", async () => {
    await mountApp();
    await runGenieOn("hello");
    const id = requestId();
    const inFlight = streamHandlers();
    stream({ chunk: "How" });

    press("Cancel");
    await settle();

    expect(callsOf("cancel_ai_prompt")).toEqual([{ requestId: id }]);
    expect(streamHandlers()).toEqual([]);
    // A frame already queued for the listener that was just released.
    stream({ requestId: id, chunk: "dy", done: true }, inFlight);

    expect(useGeniePickerStore.getState().responseText).toBe("");
    expect(suggestions()).toEqual([]);
    expect(storedDocument()).toBe(ORIGINAL);
    expect(invocation()).toMatchObject({ isRunning: false, error: null });
  });

  it.each([
    ["an error frame", () => {}, () => stream({ error: "rate limited" }), "rate limited"],
    // An empty answer is an error too, never an empty replacement.
    ["a whitespace-only answer", () => {}, () => stream({ chunk: " \n", done: true }), "AI returned an empty response"],
    ["a rejected run_ai_prompt", () => stub("run_ai_prompt", () => Promise.reject(new Error("provider exploded"))), () => {}, "provider exploded"],
  ])("%s is shown, leaves the document untouched and frees the lock for the next run", async (_case, arrange, fail, message) => {
    await mountApp();
    arrange();
    await runGenieOn("hello");

    fail();

    expect(within(picker()).getByText(message)).toBeInTheDocument();
    expect(invocation().isRunning).toBe(false);
    expect(streamHandlers()).toEqual([]);
    expect(suggestions()).toEqual([]);
    expect(storedDocument()).toBe(ORIGINAL);

    stub("run_ai_prompt", () => undefined);
    press("Dismiss");
    await runGenieOn("hello");
    expect(callsOf("run_ai_prompt")).toHaveLength(2);
    expect(invocation().isRunning).toBe(true);
  });
});

describe("a genie run that must not start", () => {
  it.each([
    ["no provider at all", { activeProvider: null, restProviders: [] }, "No AI provider available. Configure one in Settings.", ["load_genies", "detect_ai_providers"]],
    ["a blank API key", { restProviders: [{ ...OPENAI, apiKey: "  " }] }, "OpenAI API key is required. Configure it in Settings → Integrations.", ["load_genies"]],
  ])("%s: says so, closes the picker, and never reaches run_ai_prompt", async (_case, providers, message, ipc) => {
    useAiProviderStore.setState(providers);
    stub("detect_ai_providers", () => []);
    await mountApp();

    await runGenieOn("hello");

    expect(toast.error).toHaveBeenCalledWith(message);
    expect(calls.map((c) => c.cmd)).toEqual(ipc);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invocation().isRunning).toBe(false);
    expect(storedDocument()).toBe(ORIGINAL);
    expect(useGeniesStore.getState().recentGenieNames).toEqual([]); // refused is not "ran"
  });
});
