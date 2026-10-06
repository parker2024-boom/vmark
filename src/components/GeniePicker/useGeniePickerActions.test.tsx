// WI-RA17A.2 — the genie picker's actions: select, two-step freeform submit, key handling per mode
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useGeniePickerStore, type PickerMode } from "@/stores/geniePickerStore";
import type { GenieDefinition, GenieScope } from "@/types/aiGenies";
import type { InvocationSession } from "./useInvocationSession";
import type { GeniePickerState, PromptHistory } from "./useGeniePickerState";
import { useGeniePickerActions } from "./useGeniePickerActions";

const mockInvokeGenie = vi.fn(async () => {});
const mockInvokeFreeform = vi.fn(async () => {});
const mockCancel = vi.fn();
vi.mock("@/hooks/useGenieInvocation", () => ({
  useGenieInvocation: () => ({
    invokeGenie: mockInvokeGenie,
    invokeFreeform: mockInvokeFreeform,
    cancel: mockCancel,
  }),
}));

function makeGenie(name: string): GenieDefinition {
  return {
    metadata: { name, description: "", scope: "selection", category: "Writing" },
    template: "{{content}}",
    filePath: `/genies/${name}.md`,
    source: "global",
  } as GenieDefinition;
}

interface Options {
  flatList?: GenieDefinition[];
  filter?: string;
  loading?: boolean;
  freeformConfirmed?: boolean;
  activeScope?: GenieScope | null;
  composing?: boolean;
}

function makeState(o: Options): GeniePickerState {
  const filter = o.filter ?? "";
  return {
    genies: o.flatList ?? [],
    loading: o.loading ?? false,
    filter,
    changeFilter: vi.fn(),
    query: filter.trim(),
    recents: [],
    grouped: new Map(),
    flatList: o.flatList ?? [],
    selectedIndex: 0,
    setSelectedIndex: vi.fn(),
    activeScope: o.activeScope ?? null,
    setActiveScope: vi.fn(),
    freeformConfirmed: o.freeformConfirmed ?? false,
    setFreeformConfirmed: vi.fn(),
    showProviderSwitcher: false,
    setShowProviderSwitcher: vi.fn(),
    resetInput: vi.fn(),
  };
}

const session: InvocationSession = {
  claim: () => () => true,
  takeSuggestionId: () => null,
  rejectSuggestion: vi.fn(),
};
const promptHistory: PromptHistory = {
  displayValue: "",
  ghostText: "",
  handleChange: vi.fn(),
  handleKeyDown: vi.fn(),
  recordAndReset: vi.fn(),
  reset: vi.fn(),
  isDropdownOpen: false,
  dropdownEntries: [],
  dropdownSelectedIndex: 0,
  openDropdown: vi.fn(),
  closeDropdown: vi.fn(),
  selectDropdownEntry: vi.fn(),
  clearHistory: vi.fn(),
};

function Harness({ state, mode, composing }: { state: GeniePickerState; mode: PickerMode; composing: boolean }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ime = { isComposing: () => composing, onCompositionStart: vi.fn(), onCompositionEnd: vi.fn() };
  const { handleKeyDown } = useGeniePickerActions({ state, mode, session, inputRef, ime, promptHistory });
  return (
    <div data-testid="panel" onKeyDown={handleKeyDown}>
      <textarea ref={inputRef} data-testid="input" />
      <button type="button">control</button>
    </div>
  );
}

function setup(o: Options = {}, mode: PickerMode = "search") {
  const state = makeState(o);
  render(<Harness state={state} mode={mode} composing={o.composing ?? false} />);
  const input = screen.getByTestId("input");
  const press = (key: string, init: Partial<KeyboardEventInit> = {}, target: Element = input) =>
    fireEvent.keyDown(target, { key, ...init });
  return { state, press };
}

beforeEach(() => {
  vi.clearAllMocks();
  useGeniePickerStore.getState().openPicker();
});

describe("useGeniePickerActions — input mode", () => {
  it("Enter runs the highlighted genie in the active scope and resets the input", async () => {
    const genie = makeGenie("polish");
    const { state, press } = setup({ flatList: [genie], activeScope: "block" });
    await act(async () => press("Enter"));
    expect(mockInvokeGenie).toHaveBeenCalledWith(genie, "block");
    expect(state.resetInput).toHaveBeenCalled();
  });

  it("first Enter on unmatched text asks for confirmation", () => {
    const { state, press } = setup({ filter: "translate" });
    press("Enter");
    expect(state.setFreeformConfirmed).toHaveBeenCalledWith(true);
    expect(mockInvokeFreeform).not.toHaveBeenCalled();
  });

  it("confirmed Enter submits the trimmed prompt at selection scope by default", async () => {
    const { press } = setup({ filter: "  translate  ", freeformConfirmed: true });
    await act(async () => press("Enter"));
    expect(promptHistory.recordAndReset).toHaveBeenCalledWith("translate");
    expect(mockInvokeFreeform).toHaveBeenCalledWith("translate", "selection");
  });

  it("submits nothing while genies are loading", () => {
    setup({ filter: "translate", loading: true, freeformConfirmed: true }).press("Enter");
    expect(mockInvokeFreeform).not.toHaveBeenCalled();
  });

  it("submits nothing when the text is blank", () => {
    const { state, press } = setup({ filter: "   ", freeformConfirmed: true });
    press("Enter");
    expect(mockInvokeFreeform).not.toHaveBeenCalled();
    expect(state.setFreeformConfirmed).not.toHaveBeenCalled();
  });

  it("Escape closes the picker", () => {
    const { state, press } = setup();
    press("Escape");
    expect(useGeniePickerStore.getState().isOpen).toBe(false);
    expect(state.resetInput).toHaveBeenCalled();
  });

  it("Tab cycles the scope and arrows move the selection", () => {
    const { state, press } = setup({ flatList: [makeGenie("a"), makeGenie("b")] });
    press("Tab");
    expect(state.setActiveScope).toHaveBeenCalledWith("selection");
    press("ArrowDown");
    expect(state.setSelectedIndex).toHaveBeenCalledTimes(1);
  });

  it("ignores keys while an IME composition is active", () => {
    const { state, press } = setup({ composing: true });
    press("Escape");
    expect(state.resetInput).not.toHaveBeenCalled();
  });

  it("leaves a button its own keys, except Escape", () => {
    const { state, press } = setup({ filter: "x" });
    const button = screen.getByRole("button");
    press("Enter", {}, button);
    expect(state.setFreeformConfirmed).not.toHaveBeenCalled();
    press("Escape", {}, button);
    expect(useGeniePickerStore.getState().isOpen).toBe(false);
  });
});

describe("useGeniePickerActions — response modes", () => {
  it("Escape while processing cancels the request and returns to input", () => {
    const { press } = setup({}, "processing");
    press("Escape");
    expect(mockCancel).toHaveBeenCalled();
    expect(useGeniePickerStore.getState().mode).toBe("search");
  });

  it("Escape on a preview rejects this session's suggestion", () => {
    const { press } = setup({}, "preview");
    press("Escape");
    expect(session.rejectSuggestion).toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("lets modified keys through so the answer can be copied", () => {
    const { press } = setup({}, "preview");
    const event = press("c", { metaKey: true });
    expect(event).toBe(true);
  });

  it("blocks plain typing", () => {
    const { press } = setup({}, "error");
    expect(press("a")).toBe(false);
  });
});
