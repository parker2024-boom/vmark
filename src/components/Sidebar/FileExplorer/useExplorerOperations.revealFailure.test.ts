// WI-RA20.3 — a failed reveal from the file explorer names the platform's
// file manager; it said "Failed to reveal in Finder" on every platform.
// Only Tauri and sonner (the toast boundary) are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.reject(new Error("not found"))),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn(), dismiss: vi.fn() },
}));

import { useExplorerOperations } from "./useExplorerOperations";

// The app tier defaults to macOS (src/test/platformDefault.ts); override per case.
function onPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true, writable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  onPlatform("MacIntel");
  vi.restoreAllMocks();
});

describe("useExplorerOperations reveal failure", () => {
  it.each([
    ["MacIntel", "Finder"],
    ["Win32", "Explorer"],
    ["Linux x86_64", "file manager"],
  ])("on %s names %s", async (platform, manager) => {
    onPlatform(platform);
    const { result } = renderHook(() => useExplorerOperations());
    await result.current.revealInFinder("/notes/todo.md");

    expect(revealItemInDir).toHaveBeenCalledWith("/notes/todo.md");
    const [message] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(String(message)).toContain(manager);
    if (manager !== "Finder") expect(String(message)).not.toContain("Finder");
  });
});
