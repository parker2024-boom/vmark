// @vitest-environment node
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock dependencies before imports
const mockReadText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: (...args: unknown[]) => mockReadText(...args),
}));

const mockGetState = vi.fn();
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: { getState: () => mockGetState() },
}));

import { readClipboardUrl } from "./clipboardUrl";

// Helper: settings state with optional custom protocols
function settingsWithProtocols(protocols: string[] = []) {
  return { advanced: { customLinkProtocols: protocols } };
}

describe("readClipboardUrl", () => {
  let originalNavigator: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetState.mockReturnValue(settingsWithProtocols([]));

    // Restore navigator if it was modified
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
      originalNavigator = undefined;
    }
  });

  it("returns URL when Tauri clipboard has valid URL", async () => {
    mockReadText.mockResolvedValue("https://example.com");

    const result = await readClipboardUrl();

    expect(result).toBe("https://example.com");
    expect(mockReadText).toHaveBeenCalledOnce();
  });

  it("falls back to navigator.clipboard when Tauri returns empty", async () => {
    mockReadText.mockResolvedValue("");

    const mockNavReadText = vi
      .fn()
      .mockResolvedValue("https://fallback.com");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: mockNavReadText } },
      writable: true,
      configurable: true,
    });

    const result = await readClipboardUrl();

    expect(result).toBe("https://fallback.com");
    expect(mockNavReadText).toHaveBeenCalledOnce();
  });

  it("returns null when both clipboard APIs fail", async () => {
    mockReadText.mockResolvedValue("");

    const mockNavReadText = vi
      .fn()
      .mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: mockNavReadText } },
      writable: true,
      configurable: true,
    });

    const result = await readClipboardUrl();

    expect(result).toBeNull();
  });

  it("returns null when clipboard text is not a URL", async () => {
    mockReadText.mockResolvedValue("just some plain text");

    const result = await readClipboardUrl();

    expect(result).toBeNull();
  });

  it("returns null when clipboard is empty", async () => {
    mockReadText.mockResolvedValue("");

    // No navigator fallback
    originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const result = await readClipboardUrl();

    expect(result).toBeNull();
  });

  it("trims whitespace from clipboard text", async () => {
    mockReadText.mockResolvedValue("  https://example.com  \n");

    const result = await readClipboardUrl();

    expect(result).toBe("https://example.com");
  });

  it("normalizes a bare domain to https", async () => {
    mockReadText.mockResolvedValue("example.com/page");

    const result = await readClipboardUrl();

    expect(result).toBe("https://example.com/page");
  });

  it("does not recognize a custom protocol that settings do not list", async () => {
    mockReadText.mockResolvedValue("obsidian://open?vault=test");

    const result = await readClipboardUrl();

    expect(result).toBeNull();
  });

  it("recognizes custom protocols from settings to detectAndNormalizeUrl", async () => {
    const customProtocols = ["obsidian", "vscode"];
    mockGetState.mockReturnValue(settingsWithProtocols(customProtocols));
    mockReadText.mockResolvedValue("obsidian://open?vault=test");

    const result = await readClipboardUrl();

    expect(result).toBe("obsidian://open?vault=test");
  });

  it("returns null when Tauri readText throws", async () => {
    mockReadText.mockRejectedValue(new Error("Tauri clipboard error"));

    const result = await readClipboardUrl();

    expect(result).toBeNull();
  });

  it("returns null when navigator.clipboard.readText throws", async () => {
    mockReadText.mockResolvedValue("");

    const mockNavReadText = vi
      .fn()
      .mockRejectedValue(new DOMException("Not allowed"));
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: mockNavReadText } },
      writable: true,
      configurable: true,
    });

    const result = await readClipboardUrl();

    expect(result).toBeNull();
  });

  it("handles navigator being undefined", async () => {
    mockReadText.mockResolvedValue("");

    originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const result = await readClipboardUrl();

    expect(result).toBeNull();
  });

  it("uses empty array when customLinkProtocols is undefined", async () => {
    mockGetState.mockReturnValue({ advanced: { customLinkProtocols: undefined } });
    mockReadText.mockResolvedValue("https://example.com");

    const result = await readClipboardUrl();

    expect(result).toBe("https://example.com");
  });

  it("falls back to navigator when Tauri returns null", async () => {
    mockReadText.mockResolvedValue(null);

    const mockNavReadText = vi
      .fn()
      .mockResolvedValue("https://nav.com");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: mockNavReadText } },
      writable: true,
      configurable: true,
    });

    const result = await readClipboardUrl();

    expect(result).toBe("https://nav.com");
    expect(mockNavReadText).toHaveBeenCalledOnce();
  });
});
