// @vitest-environment node
// WI-RA18.11 — a save made by an AI client through the MCP bridge is filed in
// version history as its own kind, not as the user's manual save; like a
// manual save it is never merged away or size-skipped.
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSnapshot = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
);
vi.mock("@/services/history/historyOperations", () => ({ createSnapshot }));
vi.mock("@/services/ime/imeToast", () => ({ imeToast: { warning: vi.fn() } }));

import { useSettingsStore } from "@/stores/settingsStore";
import { recordHistorySnapshot, type SaveType } from "./saveHistorySnapshot";

beforeEach(() => {
  createSnapshot.mockClear();
  useSettingsStore.setState((state) => ({
    general: { ...state.general, historyEnabled: true },
  }));
});

describe("recordHistorySnapshot", () => {
  it.each<[SaveType, string]>([
    ["manual", "manual"],
    ["auto", "auto"],
    ["mcp", "mcp"],
  ])("files a %s save as a %s snapshot", async (saveType, snapshotType) => {
    await recordHistorySnapshot("/w/文档.md", "content", saveType);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(createSnapshot.mock.calls[0]?.[0]).toBe("/w/文档.md");
    expect(createSnapshot.mock.calls[0]?.[2]).toBe(snapshotType);
  });

  it("records nothing while history is disabled", async () => {
    useSettingsStore.setState((state) => ({ general: { ...state.general, historyEnabled: false } }));
    await recordHistorySnapshot("/w/a.md", "content", "mcp");
    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
