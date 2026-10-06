// WI-RA20.7 — with no AI provider configured, a genie says so instead of
// silently picking the key-optional Ollama (API) provider and sending the
// prompt to a local server the user never set up. Runs the real provider
// store and the real genie invocation; the Tauri boundary and sonner are
// mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import i18n from "@/i18n";
import { useAiInvocationStore, useAiProviderStore } from "@/stores/aiStore";
import { useEditorStore } from "@/stores/editorStore";
import { useTabStore } from "@/stores/tabStore";
import { useUIStore } from "@/stores/uiStore";
import { setCurrentWindowLabel } from "@/services/persistence/workspaceStorage";
import { useGenieInvocation } from "@/hooks/useGenieInvocation";
import type { GenieDefinition, ProviderType } from "@/types/aiGenies";
import { DEFAULT_REST_PROVIDERS } from "./providerDefaults";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const TAB = "tab-genie";
const mockInvoke = vi.mocked(invoke);

const GENIE: GenieDefinition = {
  metadata: { name: "Polish", description: "", scope: "document" },
  template: "Polish this: {{content}}",
  filePath: "/genies/polish.md",
  source: "global",
} as GenieDefinition;

let editor: Editor | null = null;
let cliAvailable = false;

function detected() {
  return [
    { type: "claude", name: "Claude Code", command: "claude", available: cliAvailable },
    { type: "codex", name: "Codex", command: "codex", available: false },
  ];
}

const commandsCalled = () => mockInvoke.mock.calls.map(([command]) => command);
const noProviderMessage = () => i18n.t("dialog:toast.genieNoProvider");

function setRestKey(type: ProviderType, apiKey: string) {
  useAiProviderStore.setState({
    restProviders: DEFAULT_REST_PROVIDERS.map((p) => (p.type === type ? { ...p, apiKey } : p)),
  });
}

async function invokeGenie() {
  const { result } = renderHook(() => useGenieInvocation());
  await result.current.invokeGenie(GENIE);
}

beforeEach(() => {
  vi.clearAllMocks();
  cliAvailable = false;
  mockInvoke.mockReset().mockImplementation(async (command: string) =>
    command === "detect_ai_providers" ? detected() : undefined,
  );
  useAiInvocationStore.getState().cancel();
  useAiProviderStore.setState({
    activeProvider: null,
    cliProviders: [],
    restProviders: DEFAULT_REST_PROVIDERS,
    detecting: false,
  });
  useUIStore.setState({ sourceMode: false });
  setCurrentWindowLabel("main");
  useTabStore.setState({ activeTabId: { main: TAB } });
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

describe("genie invocation with no configured provider", () => {
  it("shows the no-provider message and sends nothing", async () => {
    await invokeGenie();

    expect(toast.error).toHaveBeenCalledWith(noProviderMessage());
    expect(commandsCalled()).not.toContain("run_ai_prompt");
    expect(useAiProviderStore.getState().activeProvider).toBeNull();
  });

  it("does not count a whitespace-only API key as configured", async () => {
    setRestKey("anthropic", "   ");
    await invokeGenie();

    expect(toast.error).toHaveBeenCalledWith(noProviderMessage());
    expect(commandsCalled()).not.toContain("run_ai_prompt");
  });

  it("shows the message when provider detection itself fails", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "detect_ai_providers") throw new Error("spawn failed");
      return undefined;
    });
    await invokeGenie();

    expect(toast.error).toHaveBeenCalledWith(noProviderMessage());
    expect(commandsCalled()).not.toContain("run_ai_prompt");
  });
});

describe("genie invocation with a configured provider", () => {
  it("auto-selects an installed CLI and sends the request", async () => {
    cliAvailable = true;
    await invokeGenie();

    expect(useAiProviderStore.getState().activeProvider).toBe("claude");
    expect(commandsCalled()).toContain("run_ai_prompt");
  });

  it("auto-selects a REST provider that has an API key and sends the request", async () => {
    setRestKey("anthropic", "sk-ant-test");
    await invokeGenie();

    expect(useAiProviderStore.getState().activeProvider).toBe("anthropic");
    expect(commandsCalled()).toContain("run_ai_prompt");
  });

  it("honours Ollama (API) when the user chose it, though it needs no key", async () => {
    useAiProviderStore.getState().activateProvider("ollama-api");
    await invokeGenie();

    expect(toast.error).not.toHaveBeenCalledWith(noProviderMessage());
    expect(commandsCalled()).toContain("run_ai_prompt");
  });
});
