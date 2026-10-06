import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/utils/debug", () => ({
  outlineSyncError: vi.fn(),
}));

vi.mock("@/utils/safeUnlisten", () => ({
  safeUnlisten: vi.fn(),
}));

vi.mock("@/utils/markdownOutline", () => ({
  parseFenceDelimiter: vi.fn(() => null),
}));

const mockSetActiveHeadingLine = vi.fn();
vi.mock("@/stores/uiStore", () => ({
  useUIStore: {
    getState: () => ({ setActiveHeadingLine: mockSetActiveHeadingLine }),
  },
}));

import { renderHook } from "@testing-library/react";
import { useSourceOutlineSync } from "../useSourceOutlineSync";

function makeMockCMView() {
  const dom = document.createElement("div");
  return {
    ref: {
      current: {
        dom,
        state: {
          selection: { main: { head: 50 } },
          doc: {
            lineAt: () => ({ number: 3 }),
            lines: 5,
            line: (n: number) => ({
              text: n === 2 ? "## Heading" : "regular text",
              from: (n - 1) * 20,
            }),
          },
        },
      },
    } as any,
    dom,
  };
}

describe("useSourceOutlineSync debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire after 16ms (rAF frame) — proves debounce", () => {
    const { ref, dom } = makeMockCMView();
    renderHook(() => useSourceOutlineSync(ref, false));

    const callsAfterInit = mockSetActiveHeadingLine.mock.calls.length;
    dom.dispatchEvent(new Event("keyup"));

    vi.advanceTimersByTime(16);
    expect(mockSetActiveHeadingLine).toHaveBeenCalledTimes(callsAfterInit);
  });

  it("fires after 250ms debounce delay", () => {
    const { ref, dom } = makeMockCMView();
    renderHook(() => useSourceOutlineSync(ref, false));

    const callsAfterInit = mockSetActiveHeadingLine.mock.calls.length;
    dom.dispatchEvent(new Event("keyup"));

    vi.advanceTimersByTime(250);
    expect(mockSetActiveHeadingLine).toHaveBeenCalledTimes(callsAfterInit + 1);
  });

  it("coalesces rapid events into single update", () => {
    const { ref, dom } = makeMockCMView();
    renderHook(() => useSourceOutlineSync(ref, false));

    const callsAfterInit = mockSetActiveHeadingLine.mock.calls.length;

    for (let i = 0; i < 10; i++) {
      dom.dispatchEvent(new Event("keyup"));
    }
    vi.advanceTimersByTime(250);

    expect(mockSetActiveHeadingLine).toHaveBeenCalledTimes(callsAfterInit + 1);
  });
});
