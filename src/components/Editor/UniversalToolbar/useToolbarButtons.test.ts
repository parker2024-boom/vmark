// WI-RA17A.2 — the universal toolbar's button model and roving-focus predicates
import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { getGroupButtons } from "./toolbarGroups";
import { useToolbarButtons } from "./useToolbarButtons";

beforeEach(() => {
  useUIStore.getState().setSourceMode(false);
});

describe("useToolbarButtons", () => {
  it("has one button per group and a state for each", () => {
    const { result } = renderHook(() => useToolbarButtons());
    expect(result.current.buttons.map((b) => b.id)).toEqual(getGroupButtons().map((b) => b.id));
    expect(result.current.buttonStates).toHaveLength(result.current.buttons.length);
  });

  it("puts the AI-Prompts pseudo-button after the groups, always focusable and never a dropdown", () => {
    const { result } = renderHook(() => useToolbarButtons());
    const { genieFocusIndex, buttons, isButtonFocusable, isDropdownButton } = result.current;
    expect(genieFocusIndex).toBe(buttons.length);
    expect(isButtonFocusable(genieFocusIndex)).toBe(true);
    expect(isDropdownButton(genieFocusIndex)).toBe(false);
  });

  it("treats a group button as focusable exactly when its state is enabled", () => {
    const { result } = renderHook(() => useToolbarButtons());
    result.current.buttons.forEach((_, index) => {
      expect(result.current.isButtonFocusable(index)).toBe(!result.current.buttonStates[index].disabled);
    });
  });

  it("reports dropdown buttons by type and nothing past the end", () => {
    const { result } = renderHook(() => useToolbarButtons());
    result.current.buttons.forEach((button, index) => {
      expect(result.current.isDropdownButton(index)).toBe(button.type === "dropdown");
    });
    expect(result.current.isDropdownButton(result.current.genieFocusIndex + 1)).toBe(false);
  });

  it("evaluates against the Source surface in source mode and WYSIWYG otherwise", () => {
    const { result } = renderHook(() => useToolbarButtons());
    expect(result.current.toolbarContext.surface).toBe("wysiwyg");
    act(() => useUIStore.getState().setSourceMode(true));
    expect(result.current.toolbarContext.surface).toBe("source");
  });
});
