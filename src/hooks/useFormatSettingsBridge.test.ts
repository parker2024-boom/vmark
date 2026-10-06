// WI-RA14D.1 — the format-settings bridge hook installs the subscription on mount
// and removes it on unmount, so a settings change after unmount recomputes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFormatSettingsBridge } from "./useFormatSettingsBridge";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTabStore } from "@/stores/tabStore";

const realRecompute = useTabStore.getState().recomputeAllFormatIds;
const recompute = vi.fn();

function setAssociations(associations: Record<string, string>): void {
  useSettingsStore.setState((s) => ({ formats: { ...s.formats, associations } }));
}

beforeEach(() => {
  setAssociations({});
  recompute.mockReset();
  useTabStore.setState({ recomputeAllFormatIds: recompute });
});

afterEach(() => {
  useTabStore.setState({ recomputeAllFormatIds: realRecompute });
});

describe("useFormatSettingsBridge", () => {
  it("recomputes every tab's format once on mount (hot-exit-restored tabs)", () => {
    renderHook(() => useFormatSettingsBridge());
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it("recomputes again when the user's format associations change while mounted", () => {
    renderHook(() => useFormatSettingsBridge());
    recompute.mockClear();

    setAssociations({ conf: "yaml" });
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it("stops listening after unmount", () => {
    const { unmount } = renderHook(() => useFormatSettingsBridge());
    unmount();
    recompute.mockClear();

    setAssociations({ conf: "toml" });
    expect(recompute).not.toHaveBeenCalled();
  });

  it("installs one subscription per mount, not one per render", () => {
    const { rerender } = renderHook(() => useFormatSettingsBridge());
    rerender();
    rerender();
    recompute.mockClear();

    setAssociations({ ini: "toml" });
    expect(recompute).toHaveBeenCalledTimes(1);
  });
});
