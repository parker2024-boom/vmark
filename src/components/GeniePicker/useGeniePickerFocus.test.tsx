// WI-RA17A.2 — the genie picker's focus hand-off: focus the input on open, restore on close
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGeniePickerFocus } from "./useGeniePickerFocus";

describe("useGeniePickerFocus", () => {
  let input: HTMLTextAreaElement;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    opener = document.createElement("button");
    input = document.createElement("textarea");
    document.body.append(opener, input);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    opener.remove();
    input.remove();
  });

  it("focuses the input when the picker opens", () => {
    renderHook(() => useGeniePickerFocus(true, { current: input }));
    expect(document.activeElement).toBe(input);
  });

  it("does nothing while closed", () => {
    opener.focus();
    renderHook(() => useGeniePickerFocus(false, { current: input }));
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the element focused before opening when it closes", () => {
    opener.focus();
    const { rerender } = renderHook(({ open }) => useGeniePickerFocus(open, { current: input }), {
      initialProps: { open: true },
    });
    expect(document.activeElement).toBe(input);
    rerender({ open: false });
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the original opener when the open picker re-renders", () => {
    opener.focus();
    const { rerender } = renderHook(({ open }) => useGeniePickerFocus(open, { current: input }), {
      initialProps: { open: true },
    });
    rerender({ open: true });
    rerender({ open: false });
    expect(document.activeElement).toBe(opener);
  });
});
