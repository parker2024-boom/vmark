// WI-RA21.6 — a version the user chose to skip is not announced.
//
// "Skip This Version" stores `update.skipVersion`, and useUpdateChecker drops
// an available update that matches it — but the status-bar toast decided on
// its own and announced "update available" for that very version first.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const sonner = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);

// sonner is the external boundary; the ime wrapper, stores and hooks are real.
vi.mock("sonner", () => ({ toast: sonner }));

import { useMcpStore } from "@/stores/mcpStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { updateToastDescriptor, useUpdateToasts } from "./useStatusToasts";

function setUpdate(patch: Record<string, unknown>) {
  act(() => {
    useMcpStore.setState((s) => ({ update: { ...s.update, ...patch } }) as never);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setUpdate({ status: "idle", updateInfo: null });
  act(() => {
    useSettingsStore.getState().updateUpdateSetting("skipVersion", null);
    useSettingsStore.getState().updateUpdateSetting("autoDownload", false);
  });
});

describe("updateToastDescriptor — skipped version", () => {
  it("does not announce an available update the user skipped", () => {
    expect(updateToastDescriptor("available", "checking", false, false, "1.2.3", "1.2.3")).toBeNull();
  });

  it.each([
    ["a different version was skipped", "1.2.3", "1.2.2"],
    ["nothing was skipped", "1.2.3", null],
    ["the available version is unknown", null, "1.2.3"],
  ])("still announces when %s", (_label, version, skipped) => {
    expect(updateToastDescriptor("available", "checking", false, false, version, skipped)).toMatchObject({
      kind: "info",
      action: "view",
    });
  });

  it("a stall is still reported for a skipped version — the toast is the only way out", () => {
    expect(updateToastDescriptor("available", "checking", true, false, "1.2.3", "1.2.3")).toMatchObject({
      kind: "warning",
      action: "recover",
    });
  });
});

describe("useUpdateToasts — skipped version", () => {
  it("stays quiet for the skipped version and speaks for the next one", async () => {
    act(() => useSettingsStore.getState().updateUpdateSetting("skipVersion", "9.9.9"));
    renderHook(() => useUpdateToasts());

    setUpdate({ status: "available", updateInfo: { version: "9.9.9" } });
    await act(async () => {});
    expect(sonner.info).not.toHaveBeenCalled();

    setUpdate({ status: "available", updateInfo: { version: "9.9.10" } });
    await act(async () => {});
    expect(sonner.info).toHaveBeenCalledTimes(1);
    expect(String(sonner.info.mock.calls[0]![0])).toContain("9.9.10");
  });

  it("skipping the version on screen withdraws its toast", async () => {
    renderHook(() => useUpdateToasts());
    setUpdate({ status: "available", updateInfo: { version: "9.9.9" } });
    await act(async () => {});
    expect(sonner.info).toHaveBeenCalledTimes(1);
    sonner.dismiss.mockClear(); // the mount's idle state dismissed it once already

    act(() => useSettingsStore.getState().updateUpdateSetting("skipVersion", "9.9.9"));
    await act(async () => {});

    expect(sonner.dismiss).toHaveBeenCalledWith("status-update");
  });
});
