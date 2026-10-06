// WI-RA14D.1 — the Window-Status overlay shows its real panel only while the
// store says open, and freezes every mounted native browser view for exactly
// that long.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

// The native browser boundary: freezing calls into Rust, so it is the seam.
const occlusion = vi.hoisted(() => ({
  browserOcclusion: { addOccluder: vi.fn(), removeOccluder: vi.fn() },
  OCCLUDER: {},
}));
vi.mock("@/services/browser/browserOcclusion", () => occlusion);

import { WindowStatusOverlay } from "./WindowStatusOverlay";
import { useWindowStatusStore } from "@/stores/windowStatusStore";
import { useBrowserUiStore } from "@/stores/browserUiStore";

beforeEach(() => {
  useWindowStatusStore.getState().reset();
  useBrowserUiStore.setState({ entries: {} });
  useBrowserUiStore.getState().ensureEntry("tab-a", "https://a.example/");
  useBrowserUiStore.getState().ensureEntry("tab-b", "https://b.example/");
  occlusion.browserOcclusion.addOccluder.mockClear();
  occlusion.browserOcclusion.removeOccluder.mockClear();
});

describe("WindowStatusOverlay", () => {
  it("renders nothing and freezes nothing while closed", () => {
    const { container } = render(<WindowStatusOverlay />);
    expect(container).toBeEmptyDOMElement();
    expect(occlusion.browserOcclusion.addOccluder).not.toHaveBeenCalled();
  });

  it("mounts the panel and freezes every mounted browser tab while open", () => {
    render(<WindowStatusOverlay />);
    act(() => useWindowStatusStore.getState().setPanelOpen(true));

    expect(within(screen.getByTestId("window-status-overlay")).getByRole("dialog")).toBeInTheDocument();
    expect(occlusion.browserOcclusion.addOccluder).toHaveBeenCalledWith("tab-a", "window-status");
    expect(occlusion.browserOcclusion.addOccluder).toHaveBeenCalledWith("tab-b", "window-status");
  });

  it("unmounts the panel and releases both freezes when closed again", () => {
    render(<WindowStatusOverlay />);
    act(() => useWindowStatusStore.getState().setPanelOpen(true));
    act(() => useWindowStatusStore.getState().setPanelOpen(false));

    expect(screen.queryByTestId("window-status-overlay")).toBeNull();
    expect(occlusion.browserOcclusion.removeOccluder).toHaveBeenCalledWith("tab-a", "window-status");
    expect(occlusion.browserOcclusion.removeOccluder).toHaveBeenCalledWith("tab-b", "window-status");
  });
});
