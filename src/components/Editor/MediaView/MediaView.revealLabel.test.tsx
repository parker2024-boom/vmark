// WI-RA20.3 — the media fallback's reveal button names the platform's file
// manager. It said "Reveal in Finder" on Windows and Linux too.
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { MediaView } from "./MediaView";

// The app tier defaults to macOS (src/test/platformDefault.ts); override per case.
function onPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true, writable: true });
}

afterEach(() => {
  cleanup();
  onPlatform("MacIntel");
});

describe("MediaView fallback reveal button", () => {
  it.each([
    ["MacIntel", "Reveal in Finder"],
    ["Win32", "Show in Explorer"],
    ["Linux x86_64", "Show in File Manager"],
  ])("on %s reads %j", (platform, label) => {
    onPlatform(platform);
    // An unknown extension renders the fallback panel directly.
    render(<MediaView path="/files/archive.xyz" />);
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("never names Finder off macOS", () => {
    onPlatform("Win32");
    render(<MediaView path="/files/archive.xyz" />);
    expect(screen.queryByText(/Finder/)).toBeNull();
  });
});
