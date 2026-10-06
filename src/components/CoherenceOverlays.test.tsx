// WI-RA14D.1 — the coherence overlay mounts (Breakdown, Claims) show their real
// panel only while their store says open, and freeze every mounted native
// browser view for exactly that long under their own occluder id.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

// The native browser boundary: freezing calls into Rust, so it is the seam.
const occlusion = vi.hoisted(() => ({
  browserOcclusion: { addOccluder: vi.fn(), removeOccluder: vi.fn() },
  OCCLUDER: {},
}));
vi.mock("@/services/browser/browserOcclusion", () => occlusion);

import { CoherenceOverlays } from "./CoherenceOverlays";
import { useBreakdownStore } from "@/stores/breakdownStore";
import { useClaimStore } from "@/stores/claimStore";
import { useBrowserUiStore } from "@/stores/browserUiStore";

beforeEach(() => {
  useBreakdownStore.getState().reset();
  useClaimStore.getState().reset();
  useBrowserUiStore.setState({ entries: {} });
  useBrowserUiStore.getState().ensureEntry("tab-a", "https://a.example/");
  occlusion.browserOcclusion.addOccluder.mockClear();
  occlusion.browserOcclusion.removeOccluder.mockClear();
});

describe("CoherenceOverlays", () => {
  it("renders neither panel and freezes nothing while both are closed", () => {
    const { container } = render(<CoherenceOverlays />);
    expect(container).toBeEmptyDOMElement();
    expect(occlusion.browserOcclusion.addOccluder).not.toHaveBeenCalled();
  });

  it("mounts the breakdown panel and freezes the browser under 'breakdown' while open", () => {
    render(<CoherenceOverlays />);
    act(() => useBreakdownStore.getState().setPanelOpen(true));

    expect(within(screen.getByTestId("breakdown-overlay")).getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("claim-overlay")).toBeNull();
    expect(occlusion.browserOcclusion.addOccluder).toHaveBeenCalledWith("tab-a", "breakdown");
    expect(occlusion.browserOcclusion.addOccluder).toHaveBeenCalledTimes(1);
  });

  it("releases the breakdown freeze and unmounts the panel when it closes", () => {
    render(<CoherenceOverlays />);
    act(() => useBreakdownStore.getState().setPanelOpen(true));
    act(() => useBreakdownStore.getState().setPanelOpen(false));

    expect(screen.queryByTestId("breakdown-overlay")).toBeNull();
    expect(occlusion.browserOcclusion.removeOccluder).toHaveBeenCalledWith("tab-a", "breakdown");
  });

  it("mounts the claim panel and freezes the browser under 'claims' while open", () => {
    render(<CoherenceOverlays />);
    act(() => useClaimStore.getState().setPanelOpen(true));

    expect(within(screen.getByTestId("claim-overlay")).getByText("Canon Claims")).toBeInTheDocument();
    expect(screen.queryByTestId("breakdown-overlay")).toBeNull();
    expect(occlusion.browserOcclusion.addOccluder).toHaveBeenCalledWith("tab-a", "claims");
  });

  it("keeps the two freezes independent when both panels are open", () => {
    render(<CoherenceOverlays />);
    act(() => {
      useBreakdownStore.getState().setPanelOpen(true);
      useClaimStore.getState().setPanelOpen(true);
    });
    act(() => useClaimStore.getState().setPanelOpen(false));

    expect(screen.getByTestId("breakdown-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("claim-overlay")).toBeNull();
    expect(occlusion.browserOcclusion.removeOccluder).toHaveBeenCalledWith("tab-a", "claims");
    expect(occlusion.browserOcclusion.removeOccluder).not.toHaveBeenCalledWith("tab-a", "breakdown");
  });
});
