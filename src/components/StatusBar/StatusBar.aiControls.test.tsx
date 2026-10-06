// WI-RA19.3 — the status bar's AI controls act on the invocation, not only on
// the status row: Retry re-runs the request that failed (it used to only
// dismiss the error, duplicating the × beside it), Retry is absent when the
// failure has nothing to re-run, and Cancel asks Rust to stop the provider
// (it used to reset the store while the provider ran on, still billing).
// Rendered with the REAL StatusBarRight and indicator, so the buttons the
// user clicks are the ones under test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockInvoke = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@/contexts/WindowContext", () => ({
  useWindowLabel: () => "main",
  useIsDocumentWindow: () => true,
}));

vi.mock("@/hooks/useMcpServer", () => ({
  useMcpServer: () => ({
    running: false,
    loading: false,
    error: null,
    port: null,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("@/hooks/useMcpClients", () => ({
  useMcpClients: () => [],
}));

vi.mock("@/services/tabs/tabOperations", () => ({
  closeTabWithDirtyCheck: vi.fn(),
}));

vi.mock("@/services/navigation/settingsWindow", () => ({
  openSettingsWindow: vi.fn(),
}));

vi.mock("./useStatusBarTabDrag", () => ({
  useStatusBarTabDrag: () => ({
    getTabDragHandlers: () => ({ onPointerDown: vi.fn() }),
    isDragging: false,
    isReordering: false,
    dragMode: "idle",
    dragTabId: null,
    dropIndex: null,
    dragPoint: null,
    snapbackTabId: null,
    isDropPreviewTarget: false,
    isDropInvalid: false,
    isReorderBlocked: false,
    dragHint: null,
    ariaAnnouncement: "",
    handleTabKeyDown: vi.fn(),
  }),
}));

vi.mock("./useQuitFeedback", () => ({
  useQuitFeedback: () => false,
}));

vi.mock("@/components/Tabs/Tab", () => ({
  Tab: () => <div data-testid="tab" />,
}));

vi.mock("@/components/Tabs/TabContextMenu", () => ({
  TabContextMenu: () => null,
}));

import { StatusBar } from "./StatusBar";
import { useUIStore } from "@/stores/uiStore";
import { useAiInvocationStore } from "@/stores/aiStore";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const store = () => useAiInvocationStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ statusBarVisible: true });
  store().cancel();
});

describe("status bar AI controls", () => {
  it("Retry re-runs the failed request and clears the error", () => {
    const retry = vi.fn();
    store().tryStart("r1");
    store().setError("Provider timeout", "r1", retry);
    render(<StatusBar />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(retry).toHaveBeenCalledOnce();
    expect(store().error).toBeNull();
  });

  it("offers no Retry when the failure has nothing to re-run", () => {
    store().setError("No provider set up");
    render(<StatusBar />);
    expect(screen.getByText("No provider set up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss error" })).toBeInTheDocument();
  });

  it("Cancel asks Rust to stop the running request, then resets the status", () => {
    store().tryStart("req-42");
    render(<StatusBar />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel AI request" }));

    expect(mockInvoke).toHaveBeenCalledWith("cancel_ai_prompt", { requestId: "req-42" });
    expect(store().isRunning).toBe(false);
  });
});
