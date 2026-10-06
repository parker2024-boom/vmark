// WI-RA14D.1 — the genie-picker mount shows the real picker while it is open and
// freezes every mounted native browser view for exactly that long.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// The native browser boundary: freezing calls into Rust, so it is the seam.
const occlusion = vi.hoisted(() => ({
  browserOcclusion: { addOccluder: vi.fn(), removeOccluder: vi.fn() },
  OCCLUDER: {},
}));
vi.mock("@/services/browser/browserOcclusion", () => occlusion);

import { GeniePickerOverlay } from "./GeniePickerOverlay";
import { useGeniePickerStore } from "@/stores/geniePickerStore";
import { useBrowserUiStore } from "@/stores/browserUiStore";

beforeEach(() => {
  useGeniePickerStore.getState().closePicker();
  useBrowserUiStore.setState({ entries: {} });
  useBrowserUiStore.getState().ensureEntry("tab-a", "https://a.example/");
  occlusion.browserOcclusion.addOccluder.mockClear();
  occlusion.browserOcclusion.removeOccluder.mockClear();
});

describe("GeniePickerOverlay", () => {
  it("shows no picker and freezes nothing while closed", () => {
    render(<GeniePickerOverlay />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(occlusion.browserOcclusion.addOccluder).not.toHaveBeenCalled();
  });

  it("shows the picker and freezes the browser under 'genie-picker' while open", () => {
    render(<GeniePickerOverlay />);
    act(() => useGeniePickerStore.getState().openPicker());

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(occlusion.browserOcclusion.addOccluder).toHaveBeenCalledWith("tab-a", "genie-picker");
    expect(occlusion.browserOcclusion.removeOccluder).not.toHaveBeenCalled();
  });

  it("hides the picker and releases the freeze when it closes", () => {
    render(<GeniePickerOverlay />);
    act(() => useGeniePickerStore.getState().openPicker());
    act(() => useGeniePickerStore.getState().closePicker());

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(occlusion.browserOcclusion.removeOccluder).toHaveBeenCalledWith("tab-a", "genie-picker");
  });
});
