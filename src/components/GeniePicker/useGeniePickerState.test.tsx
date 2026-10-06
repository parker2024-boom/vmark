// WI-RA17A.2 — the genie picker's input state: open reset, list derivation, clamping, history sync
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGeniesStore } from "@/stores/aiStore";
import { useQuickOpenStore } from "@/stores/quickOpenStore";
import type { GenieDefinition, GenieScope } from "@/types/aiGenies";
import { useGeniePickerState, type PromptHistory } from "./useGeniePickerState";

function makeGenie(name: string, scope: GenieScope = "selection", category = "Writing"): GenieDefinition {
  return {
    metadata: { name, description: `${name} description`, scope, category },
    template: "{{content}}",
    filePath: `/genies/${name}.md`,
    source: "global",
  } as GenieDefinition;
}

function makeHistory(overrides: Partial<PromptHistory> = {}): PromptHistory {
  return {
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
    ...overrides,
  } as PromptHistory;
}

interface Props {
  isOpen: boolean;
  scope: GenieScope | null;
  history: PromptHistory;
}

function setup(initial: Partial<Props> = {}) {
  const initialProps: Props = { isOpen: true, scope: null, history: makeHistory(), ...initial };
  return renderHook(
    ({ isOpen, scope, history }: Props) => useGeniePickerState(isOpen, scope, history, "Other"),
    { initialProps },
  );
}

const loadGenies = vi.fn(async () => {});

beforeEach(() => {
  loadGenies.mockClear();
  useGeniesStore.setState({ genies: [], loading: false, recentGenieNames: [], loadGenies });
  useQuickOpenStore.setState({ isOpen: false });
});

describe("useGeniePickerState — opening", () => {
  it("loads genies, closes quick open and adopts the requested scope", () => {
    useQuickOpenStore.setState({ isOpen: true });
    const { result } = setup({ scope: "block" });
    expect(loadGenies).toHaveBeenCalledTimes(1);
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(result.current.activeScope).toBe("block");
  });

  it("does nothing while closed", () => {
    setup({ isOpen: false });
    expect(loadGenies).not.toHaveBeenCalled();
  });

  it("resets the typed text and prompt history when re-opened at another scope", () => {
    // A matching genie keeps the history sync (which owns the text only when
    // nothing matches) out of this case.
    useGeniesStore.setState({ genies: [makeGenie("abc")] });
    const history = makeHistory();
    const { result, rerender } = setup({ history });
    act(() => result.current.changeFilter("abc"));
    expect(history.handleChange).toHaveBeenCalledWith("abc");
    expect(result.current.filter).toBe("abc");

    rerender({ isOpen: true, scope: "document", history });
    expect(result.current.filter).toBe("");
    expect(result.current.activeScope).toBe("document");
    expect(history.reset).toHaveBeenCalled();
  });

  it("logs rather than throws when loading genies fails", async () => {
    loadGenies.mockRejectedValueOnce(new Error("disk"));
    setup();
    await act(async () => {});
    expect(loadGenies).toHaveBeenCalled();
  });
});

describe("useGeniePickerState — list derivation", () => {
  it("filters by the trimmed query and the active scope, grouping by category", () => {
    useGeniesStore.setState({
      genies: [makeGenie("polish"), makeGenie("summarize", "document"), makeGenie("proofread")],
    });
    const { result } = setup({ scope: "selection" });
    expect(result.current.flatList.map((g) => g.metadata.name)).toEqual(["polish", "proofread"]);

    act(() => result.current.changeFilter("  polish  "));
    expect(result.current.query).toBe("polish");
    expect(result.current.flatList.map((g) => g.metadata.name)).toEqual(["polish"]);
    expect([...result.current.grouped.keys()]).toEqual(["Writing"]);
  });

  it("lists recents ahead of the categories", () => {
    useGeniesStore.setState({
      genies: [makeGenie("polish"), makeGenie("proofread")],
      recentGenieNames: ["proofread"],
    });
    const { result } = setup();
    expect(result.current.recents.map((g) => g.metadata.name)).toEqual(["proofread"]);
    expect(result.current.flatList[0].metadata.name).toBe("proofread");
  });

  it("clamps the selected index when the list shrinks", () => {
    useGeniesStore.setState({ genies: [makeGenie("alpha"), makeGenie("beta"), makeGenie("gamma")] });
    const { result } = setup();
    act(() => result.current.setSelectedIndex(2));
    act(() => useGeniesStore.setState({ genies: [makeGenie("alpha")] }));
    expect(result.current.selectedIndex).toBe(0);
  });
});

describe("useGeniePickerState — typing and history", () => {
  it("typing resets the selection and the freeform confirmation", () => {
    useGeniesStore.setState({ genies: [makeGenie("alpha"), makeGenie("beta")] });
    const { result } = setup();
    act(() => {
      result.current.setSelectedIndex(1);
      result.current.setFreeformConfirmed(true);
    });
    act(() => result.current.changeFilter("a"));
    expect(result.current.selectedIndex).toBe(0);
    expect(result.current.freeformConfirmed).toBe(false);
  });

  it("adopts a cycled history prompt and drops the confirmation when nothing matches", () => {
    const { result, rerender } = setup();
    act(() => result.current.setFreeformConfirmed(true));
    rerender({ isOpen: true, scope: null, history: makeHistory({ displayValue: "older prompt" }) });
    expect(result.current.filter).toBe("older prompt");
    expect(result.current.freeformConfirmed).toBe(false);
  });

  it("ignores history while genies match", () => {
    useGeniesStore.setState({ genies: [makeGenie("alpha")] });
    const { result, rerender } = setup();
    rerender({ isOpen: true, scope: null, history: makeHistory({ displayValue: "older prompt" }) });
    expect(result.current.filter).toBe("");
  });

  it("resetInput clears every input field and closes the provider switcher", () => {
    const history = makeHistory();
    const { result } = setup({ history });
    act(() => {
      result.current.changeFilter("x");
      result.current.setFreeformConfirmed(true);
      result.current.setShowProviderSwitcher(true);
    });
    act(() => result.current.resetInput());
    expect(result.current.filter).toBe("");
    expect(result.current.freeformConfirmed).toBe(false);
    expect(result.current.showProviderSwitcher).toBe(false);
    expect(history.reset).toHaveBeenCalled();
  });
});
