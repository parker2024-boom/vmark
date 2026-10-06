/**
 * WindowContext Tests
 *
 * Tests for the WindowProvider, useWindowLabel, and useIsDocumentWindow hooks.
 * Covers: context provider/consumer pattern, label detection, error boundaries,
 * and settings/doc-window branching. What a window opens from its `file`,
 * `files` and `workspaceRoot` params runs against the real opener and stores in
 * WindowContext.startupFiles.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, renderHook } from "@testing-library/react";
import type { TabRemovalRequestEvent } from "@/types/tabTransfer";

// --- Mocks (must precede imports) ---

type ListenHandler = (e: { payload: unknown }) => void;

const {
  mockEmit,
  mockListen,
  mockCreateTab,
  mockGetTabsByWindow,
  mockInitDocument,
  mockRehydrate,
  mockCloseWorkspace,
  mockDetachTab,
  mockRemoveDocument,
  mockCreateTransferredTab,
  mockUpdateTabTitle,
  mockWorkspaceState,
} = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  // Typed to the real signatures: a bare `vi.fn(() => …)` has a ZERO-parameter
  // type, so `mock.calls[n][1]` indexes an empty tuple — 22 type errors vitest
  // never reports, because it transpiles tests without checking them.
  mockListen: vi.fn((_e: string, _h: ListenHandler): Promise<() => void> => Promise.resolve(vi.fn())),
  mockCreateTab: vi.fn((_windowLabel: string, _filePath: string | null) => "tab-1"),
  mockGetTabsByWindow: vi.fn(() => [] as unknown[]),
  mockInitDocument: vi.fn(),
  mockRehydrate: vi.fn(),
  mockCloseWorkspace: vi.fn(),
  mockDetachTab: vi.fn(),
  mockRemoveDocument: vi.fn(),
  mockCreateTransferredTab: vi.fn(() => "tab-t"),
  mockUpdateTabTitle: vi.fn(),
  mockWorkspaceState: {
    rootPath: null as string | null,
    isWorkspaceMode: false,
  },
}));

let mockWindowLabel = "main";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: mockWindowLabel,
    emit: mockEmit,
    listen: mockListen,
    close: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(() => Promise.resolve("")),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../stores/documentStore", () => ({
  useDocumentStore: {
    getState: () => ({
      initDocument: mockInitDocument,
      setLineMetadata: vi.fn(),
      removeDocument: mockRemoveDocument,
    }),
  },
  useUnifiedHistoryStore: {
    getState: () => ({ documents: {}, clearDocument: vi.fn() }),
    subscribe: () => () => {},
  },
  useRevisionStore: { getState: () => ({ registerEdit: vi.fn(), clearRevision: vi.fn(), updateRevision: vi.fn(), setRevision: vi.fn(), getRevision: vi.fn(() => "rev-mock") }) },
  useLintStore: {
    getState: () => ({ clearDiagnostics: vi.fn() }),
    subscribe: () => () => {},
  },
  useLargeFileSessionStore: {
    getState: () => ({ clearForcedSource: vi.fn() }),
    subscribe: () => () => {},
  },
  useFileLoadStore: { getState: () => ({ active: false }) },
}));

vi.mock("../stores/tabStore", () => ({
  useTabStore: {
    getState: () => ({
      createTab: mockCreateTab,
      getTabsByWindow: mockGetTabsByWindow,
      createTransferredTab: mockCreateTransferredTab,
      updateTabTitle: mockUpdateTabTitle,
      detachTab: mockDetachTab,
    }),
  },
}));

vi.mock("../stores/workspaceStore", () => ({
  useRecentFilesStore: {
    getState: () => ({ addFile: vi.fn() }),
  },
  useWorkspaceStore: {
    getState: () => ({
      rootPath: mockWorkspaceState.rootPath,
      isWorkspaceMode: mockWorkspaceState.isWorkspaceMode,
      closeWorkspace: mockCloseWorkspace,
    }),
    persist: { rehydrate: mockRehydrate },
  },

}));

vi.mock("@/services/persistence/workspaceStorage", () => ({
  setCurrentWindowLabel: vi.fn(),
  migrateWorkspaceStorage: vi.fn(),
  getWorkspaceStorageKey: vi.fn((label: string) => `vmark-workspace:${label}`),
  findActiveWorkspaceLabel: vi.fn(() => null),
}));

vi.mock("@/services/workspaces/openWorkspaceWithConfig", () => ({
  openWorkspaceWithConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/useWorkspaceSync", () => ({
  useWorkspaceSync: vi.fn(),
}));

vi.mock("@/utils/debug", () => ({
  windowCloseWarn: vi.fn(),
  windowContextError: vi.fn(),
}));

// Now import components under test
import { WindowProvider, useWindowLabel, useIsDocumentWindow } from "./WindowContext";
import { windowContextError as _windowContextError } from "@/utils/debug";
const mockWindowContextError = vi.mocked(_windowContextError);

describe("WindowContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindowLabel = "main";
    mockGetTabsByWindow.mockReturnValue([]);
    mockCreateTab.mockReturnValue("tab-1");
    mockCreateTransferredTab.mockReturnValue("tab-t");
    mockListen.mockImplementation(() => Promise.resolve(vi.fn()));
    mockWorkspaceState.rootPath = null;
    mockWorkspaceState.isWorkspaceMode = false;
    // Reset location.search
    Object.defineProperty(globalThis, "location", {
      value: { search: "" },
      writable: true,
      configurable: true,
    });
  });

  describe("WindowProvider", () => {
    it("renders children after initialization", async () => {
      render(
        <WindowProvider>
          <div data-testid="child">Hello</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
      });
    });

    it("emits ready event to Rust after init", async () => {
      vi.useFakeTimers();

      render(
        <WindowProvider>
          <div>content</div>
        </WindowProvider>,
      );

      // Allow async init to complete
      await vi.advanceTimersByTimeAsync(200);

      expect(mockEmit).toHaveBeenCalledWith("ready", "main");

      vi.useRealTimers();
    });


    it("skips document init for settings window", async () => {
      mockWindowLabel = "settings";

      render(
        <WindowProvider>
          <div data-testid="child">Settings</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
      });

      // Should not create tabs for settings window
      expect(mockCreateTab).not.toHaveBeenCalled();
    });

    it("skips document init when tabs already exist", async () => {
      mockGetTabsByWindow.mockReturnValue([{ id: "existing-tab" }]);

      render(
        <WindowProvider>
          <div>content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(mockCreateTab).not.toHaveBeenCalled();
      });
    });

    it("sets up tab:transfer and tab:remove-by-id listeners for doc windows", async () => {
      render(
        <WindowProvider>
          <div>content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith("tab:transfer", expect.any(Function));
        expect(mockListen).toHaveBeenCalledWith("tab:remove-by-id", expect.any(Function));
      });
    });

    it("does not set up tab listeners for settings window", async () => {
      mockWindowLabel = "settings";

      render(
        <WindowProvider>
          <div>content</div>
        </WindowProvider>,
      );

      // Wait for render to settle
      await waitFor(() => {
        expect(screen.getByText("content")).toBeInTheDocument();
      });

      // tab:transfer listener should not be set for settings windows
      const transferCalls = mockListen.mock.calls.filter(
        (call) => call[0] === "tab:transfer",
      );
      expect(transferCalls).toHaveLength(0);
    });

    it("rehydrates workspace store on init", async () => {
      render(
        <WindowProvider>
          <div>content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(mockRehydrate).toHaveBeenCalled();
      });
    });

    // #1313 — a fresh launch lands on the WelcomeScreen (Editor.tsx already
    // renders it for the no-tab state). `doc-*` still gets a blank tab, below.
    it("clears the workspace and opens no tab on a fresh launch (#1313)", async () => {
      mockWindowLabel = "main";

      render(
        <WindowProvider>
          <div>content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(mockCloseWorkspace).toHaveBeenCalled();
      });
      expect(mockCreateTab).not.toHaveBeenCalled();
      expect(mockInitDocument).not.toHaveBeenCalled();
    });
  });

  describe("useWindowLabel", () => {
    it("returns the window label from context", async () => {
      let label: string | undefined;

      function Consumer() {
        label = useWindowLabel();
        return <div>{label}</div>;
      }

      render(
        <WindowProvider>
          <Consumer />
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(label).toBe("main");
      });
    });

    it("throws when used outside WindowProvider", () => {
      // Suppress React error boundary console output
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(() => {
        renderHook(() => useWindowLabel());
      }).toThrow("useWindowLabel must be used within WindowProvider");

      consoleSpy.mockRestore();
    });
  });

  describe("useIsDocumentWindow", () => {
    it("returns true for main window", async () => {
      let isDoc: boolean | undefined;

      function Consumer() {
        isDoc = useIsDocumentWindow();
        return <div>{String(isDoc)}</div>;
      }

      render(
        <WindowProvider>
          <Consumer />
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(isDoc).toBe(true);
      });
    });

    it("returns true for doc-* windows", async () => {
      mockWindowLabel = "doc-123";
      let isDoc: boolean | undefined;

      function Consumer() {
        isDoc = useIsDocumentWindow();
        return <div>{String(isDoc)}</div>;
      }

      render(
        <WindowProvider>
          <Consumer />
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(isDoc).toBe(true);
      });
    });

    it("returns false for settings window", async () => {
      mockWindowLabel = "settings";
      let isDoc: boolean | undefined;

      function Consumer() {
        isDoc = useIsDocumentWindow();
        return <div>{String(isDoc)}</div>;
      }

      render(
        <WindowProvider>
          <Consumer />
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(isDoc).toBe(false);
      });
    });

    it("throws when used outside WindowProvider", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(() => {
        renderHook(() => useIsDocumentWindow());
      }).toThrow("useIsDocumentWindow must be used within WindowProvider");

      consoleSpy.mockRestore();
    });
  });

  describe("WindowProvider — settings window workspace", () => {
    it("looks for active workspace label for settings window", async () => {
      mockWindowLabel = "settings";

      render(
        <WindowProvider>
          <div data-testid="child">Settings</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
      });
    });
  });

  describe("WindowProvider — error handling", () => {
    it("still sets isReady on init error", async () => {
      // Force an error by making getCurrentWebviewWindow throw
      const origMock = vi.mocked(mockListen);
      origMock.mockImplementationOnce(() => Promise.reject(new Error("test error")));

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(
        <WindowProvider>
          <div data-testid="child">Content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
      });

      errorSpy.mockRestore();
    });
  });

  describe("WindowProvider — doc-* window clears localStorage", () => {
    it("clears persisted workspace state for doc-* window", async () => {
      mockWindowLabel = "doc-789";
      // jsdom's localStorage is a native exotic object that vi.spyOn cannot
      // intercept (the spy never registers an own property), so we observe the
      // actual side effect: a stale persisted value must be gone after init.
      const storageKey = "vmark-workspace:doc-789";
      globalThis.localStorage.setItem(storageKey, "stale-workspace-state");

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(globalThis.localStorage.getItem(storageKey)).toBeNull();
      });
    });
  });

  describe("WindowProvider — settings window uses active workspace label", () => {
    it("sets current window label to active workspace label for settings", async () => {
      mockWindowLabel = "settings";
      const { findActiveWorkspaceLabel, setCurrentWindowLabel } = await import("@/services/persistence/workspaceStorage");
      vi.mocked(findActiveWorkspaceLabel).mockReturnValue("main");

      render(
        <WindowProvider>
          <div data-testid="child">settings</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        // Should first call with "settings", then with "main" (active workspace)
        expect(setCurrentWindowLabel).toHaveBeenCalledWith("settings");
        expect(setCurrentWindowLabel).toHaveBeenCalledWith("main");
      });
    });
  });

  describe("WindowProvider — tab transfer handling", () => {
    it("handles tab transfer from URL param", async () => {
      vi.useFakeTimers();
      mockWindowLabel = "doc-new";
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockResolvedValue({
        tabId: "transferred-tab",
        title: "Transferred",
        content: "# Transferred content",
        filePath: "/docs/transferred.md",
        savedContent: "# Transferred content",
        workspaceRoot: null,
      });

      Object.defineProperty(globalThis, "location", {
        value: { search: "?transfer=true" },
        writable: true,
        configurable: true,
      });

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await vi.advanceTimersByTimeAsync(200);

      expect(vi.mocked(invoke).mock.calls).toContainEqual(["claim_tab_transfer"]);

      vi.useRealTimers();
    });
  });

  describe("WindowProvider — runtime tab transfer/remove listeners", () => {
    it("applies runtime tab:transfer event payload", async () => {
      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
      });

      // Find the tab:transfer listener callback
      await waitFor(() => {
        const transferCall = mockListen.mock.calls.find(
          (call: unknown[]) => call[0] === "tab:transfer",
        );
        expect(transferCall).toBeDefined();
      });

      const transferCall = mockListen.mock.calls.find(
        (call: unknown[]) => call[0] === "tab:transfer",
      );
      const transferHandler = transferCall![1];
      // Invoke the runtime transfer handler
      await transferHandler({
        payload: {
          tabId: "runtime-tab",
          title: "Runtime Tab",
          content: "# Runtime",
          filePath: "/docs/runtime.md",
          savedContent: "# Runtime",
          workspaceRoot: null,
        },
      });

      expect(mockCreateTransferredTab).toHaveBeenCalled();
    });

    it("handles runtime tab:transfer error gracefully", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockCreateTransferredTab.mockImplementationOnce(() => {
        throw new Error("transfer fail");
      });

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        const transferCall = mockListen.mock.calls.find(
          (call: unknown[]) => call[0] === "tab:transfer",
        );
        expect(transferCall).toBeDefined();
      });

      const transferCall = mockListen.mock.calls.find(
        (call: unknown[]) => call[0] === "tab:transfer",
      );
      const transferHandler = transferCall![1];

      await transferHandler({
        payload: {
          tabId: "fail-tab",
          title: "Fail",
          content: "",
          filePath: null,
          savedContent: "",
          workspaceRoot: null,
        },
      });

      expect(mockWindowContextError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to apply runtime tab transfer"),
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it("invokes tab:remove-by-id handler to detach tab", async () => {
      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        const removeCall = mockListen.mock.calls.find(
          (call: unknown[]) => call[0] === "tab:remove-by-id",
        );
        expect(removeCall).toBeDefined();
      });

      const removeCall = mockListen.mock.calls.find(
        (call: unknown[]) => call[0] === "tab:remove-by-id",
      );
      const removeHandler = removeCall![1];

      // Make getTabsByWindow return remaining tabs so window doesn't close
      mockGetTabsByWindow.mockReturnValue([{ id: "other-tab" }]);

      removeHandler({ payload: { requestId: "req-1", tabId: "tab-to-remove", phase: "commit" } });

      await waitFor(() => {
        expect(mockDetachTab).toHaveBeenCalledWith("main", "tab-to-remove");
      });
    });

    it("closes doc window when last tab is removed", async () => {
      mockWindowLabel = "doc-close";
      const { invoke } = await import("@tauri-apps/api/core");

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        const removeCall = mockListen.mock.calls.find(
          (call: unknown[]) => call[0] === "tab:remove-by-id",
        );
        expect(removeCall).toBeDefined();
      });

      const removeCall = mockListen.mock.calls.find(
        (call: unknown[]) => call[0] === "tab:remove-by-id",
      );
      const removeHandler = removeCall![1];

      // No remaining tabs after removal
      mockGetTabsByWindow.mockReturnValue([]);

      removeHandler({ payload: { requestId: "req-1", tabId: "last-tab", phase: "commit" } });

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith("close_window");
      });
    });

    it("cleans up listeners on unmount", async () => {
      const unlistenFn = vi.fn();
      mockListen.mockResolvedValue(unlistenFn);

      const { unmount } = render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      // Wait for both listen() calls, then flush the microtask in which their
      // .then() callbacks store unlisten/unlistenRemove.
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2);
      });
      await Promise.resolve();

      unmount();

      // unlisten should be called for both tab:transfer and tab:remove-by-id
      expect(unlistenFn).toHaveBeenCalled();
    });
  });

  describe("WindowProvider — transfer with workspace root fallback", () => {
    it("uses file path parent as workspace root fallback in applyTabTransferData", async () => {
      vi.useFakeTimers();
      mockWindowLabel = "doc-fb";
      const { invoke } = await import("@tauri-apps/api/core");
      const { openWorkspaceWithConfig } = await import("@/services/workspaces/openWorkspaceWithConfig");

      vi.mocked(invoke).mockResolvedValue({
        tabId: "t1",
        title: "T1",
        content: "# Content",
        filePath: "/docs/file.md",
        savedContent: "# Content",
        workspaceRoot: null, // no explicit workspace root
      });

      Object.defineProperty(globalThis, "location", {
        value: { search: "?transfer=true" },
        writable: true,
        configurable: true,
      });

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await vi.advanceTimersByTimeAsync(200);

      // The real open policy derives the workspace from the file's folder.
      expect(openWorkspaceWithConfig).toHaveBeenCalledWith("/docs", {
        windowLabel: "doc-fb",
      });

      vi.useRealTimers();
    });
  });

  describe("WindowProvider — tab transfer error in init", () => {
    it("catches tab transfer error and continues normal init", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockRejectedValueOnce(new Error("transfer claim failed"));

      Object.defineProperty(globalThis, "location", {
        value: { search: "?transfer=true" },
        writable: true,
        configurable: true,
      });

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await vi.advanceTimersByTimeAsync(200);

      expect(mockWindowContextError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to claim tab transfer"),
        expect.any(Error),
      );
        // Subject: a failed claim is caught and init CONTINUES — proven by the
      // logged error above plus the children rendering (#1313: no tab now).
      expect(screen.getByTestId("child")).toBeInTheDocument();
      expect(mockCreateTab).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe("WindowProvider — openWorkspaceWithConfig failure", () => {
    it("continues when workspace config open fails for URL param", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { openWorkspaceWithConfig } = await import("@/services/workspaces/openWorkspaceWithConfig");
      vi.mocked(openWorkspaceWithConfig).mockRejectedValueOnce(new Error("config failed"));

      Object.defineProperty(globalThis, "location", {
        value: { search: "?workspaceRoot=/bad/workspace" },
        writable: true,
        configurable: true,
      });

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(mockWindowContextError).toHaveBeenCalledWith(
          expect.stringContaining("Failed to open workspace from URL param"),
          expect.any(Error),
        );
      });

      errorSpy.mockRestore();
    });
  });

  describe("WindowProvider — init error handling", () => {
    it("still renders children when init throws (catch block)", async () => {
      // Make migrateWorkspaceStorage throw to trigger the init catch block
      const { migrateWorkspaceStorage } = await import("@/services/persistence/workspaceStorage");
      vi.mocked(migrateWorkspaceStorage).mockImplementation(() => {
        throw new Error("migration boom");
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(
        <WindowProvider>
          <div data-testid="child">recovered</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
      });

      // Should have logged the error
      expect(mockWindowContextError).toHaveBeenCalledWith(
        expect.stringContaining("Init failed"),
        expect.any(Error),
      );

      // The ready event is called via setTimeout; wait for it
      await waitFor(() => {
        expect(mockEmit).toHaveBeenCalledWith("ready", "main");
      });

      consoleSpy.mockRestore();
      vi.mocked(migrateWorkspaceStorage).mockImplementation(() => {});
    });

    it("handles listen failure for tab removal gracefully", async () => {
      // Ensure migrateWorkspaceStorage does not throw (reset from prior test)
      const { migrateWorkspaceStorage } = await import("@/services/persistence/workspaceStorage");
      vi.mocked(migrateWorkspaceStorage).mockImplementation(() => {});

      // Make listen reject ONLY for the tab:remove-by-id event
      mockListen.mockImplementation((event: string) => {
        if (event === "tab:remove-by-id") {
          return Promise.reject(new Error("listen failed"));
        }
        return Promise.resolve(vi.fn());
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
      });

      // The listen promise rejects asynchronously; wait for its .catch to log.
      await waitFor(() => {
        expect(mockWindowContextError).toHaveBeenCalledWith(
          expect.stringContaining("tab removal listener"),
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });
  });

  describe("closeWindowIfEmpty — close_window error path", () => {
    it("logs warning when close_window invoke fails, and still acks the commit", async () => {
      mockWindowLabel = "doc-1";
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === "close_window") return Promise.reject(new Error("close failed"));
        if (cmd === "claim_tab_transfer") return Promise.resolve(null);
        return Promise.resolve(null);
      });
      // After removing a tab, getTabsByWindow returns empty -> triggers close_window
      mockGetTabsByWindow.mockReturnValue([]);

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      // A removal arrives as the commit phase of the tab:remove-by-id listener.
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith("tab:remove-by-id", expect.any(Function));
      });
      const removeCall = mockListen.mock.calls.find((call) => call[0] === "tab:remove-by-id");
      removeCall![1]({ payload: { requestId: "req-1", tabId: "tab-1", phase: "commit" } });

      const { windowCloseWarn } = await import("../utils/debug");
      await waitFor(() => {
        expect(windowCloseWarn).toHaveBeenCalledWith("Failed to close window:", "close failed");
      });
      // A window that cannot close has still detached the tab and answered the source.
      expect(mockDetachTab).toHaveBeenCalledWith("doc-1", "tab-1");
      expect(mockEmit).toHaveBeenCalledWith("tab:remove-ack", {
        requestId: "req-1", tabId: "tab-1", phase: "commit", accepted: true,
      });

      vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
    });
  });

  describe("WindowProvider — cancelled listener callback paths", () => {
    it("returns early in tab:transfer callback when cancelled (component unmounted before event fires)", async () => {
      // This covers line 334: `if (cancelled) return;` inside the tab:transfer listener callback
      // We need to: register the listener, unmount (sets cancelled=true), then fire the listener callback
      const held: { cb: ListenHandler | null } = { cb: null }; // a `let` set inside a callback narrows to `never`

      mockListen.mockImplementation((event: string, cb: ListenHandler) => {
        if (event === "tab:transfer") {
          held.cb = cb;
        }
        return Promise.resolve(vi.fn());
      });

      const { unmount } = render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      // Wait for listeners to be registered
      await waitFor(() => {
        expect(held.cb).not.toBeNull();
      });

      // Unmount sets cancelled = true
      unmount();

      // Fire the tab:transfer callback AFTER unmount — should return early (line 334)
      // The applyTabTransferData should NOT be called
      if (held.cb) {
        await held.cb({
          payload: {
            tabId: "late-tab",
            title: "Late",
            content: "# Late",
            filePath: null,
            savedContent: "# Late",
            workspaceRoot: null,
          },
        });
      }

      // applyTabTransferData calls createTransferredTab internally
      // Since cancelled=true, it returns early so createTransferredTab is not called
      expect(mockCreateTransferredTab).not.toHaveBeenCalled();
    });

    it("returns early in tab:remove-by-id callback when cancelled", async () => {
      // This covers line 352: `if (cancelled) return;` inside the tab:remove-by-id callback
      const held: { cb: ((e: { payload: TabRemovalRequestEvent }) => void) | null } = { cb: null };

      mockListen.mockImplementation((event: string, cb: ListenHandler) => {
        if (event === "tab:remove-by-id") {
          held.cb = cb as (e: { payload: TabRemovalRequestEvent }) => void;
        }
        return Promise.resolve(vi.fn());
      });

      const { unmount } = render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      // Wait for listeners to be registered
      await waitFor(() => {
        expect(held.cb).not.toBeNull();
      });

      // Unmount sets cancelled = true
      unmount();

      // Fire the tab:remove-by-id callback AFTER unmount — should return early (line 352)
      if (held.cb) {
        held.cb({ payload: { requestId: "req-1", tabId: "stale-tab", phase: "commit" } });
      }

      // A live handler detaches synchronously on commit; cancelled=true returns
      // first. Flush a microtask so a deferred detach would show here too.
      await Promise.resolve();
      expect(mockDetachTab).not.toHaveBeenCalled();
    });

    it("calls unlistenRemove immediately when cancelled=true before tab:remove-by-id listen resolves", async () => {
      // This covers line 357: `if (cancelled) { fn(); }` for the unlistenRemove path
      let resolveRemove!: (fn: () => void) => void;
      const removeListenPromise = new Promise<() => void>((resolve) => {
        resolveRemove = resolve;
      });
      const unlistenRemoveFn = vi.fn();

      mockListen.mockImplementation((event: string) => {
        if (event === "tab:remove-by-id") return removeListenPromise;
        return Promise.resolve(vi.fn());
      });

      const { unmount } = render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      // Unmount once the listener is requested, before its promise resolves
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith("tab:remove-by-id", expect.any(Function));
      });
      unmount();

      // Now resolve — the `if (cancelled) { fn(); }` branch fires
      resolveRemove(unlistenRemoveFn);
      await waitFor(() => expect(unlistenRemoveFn).toHaveBeenCalled());
    });
  });

  describe("WindowProvider — claim_tab_transfer returns null", () => {
    it("falls through to normal init when claim_tab_transfer returns null", async () => {
      vi.useFakeTimers();
      mockWindowLabel = "doc-nulltransfer";
      const { invoke } = await import("@tauri-apps/api/core");
      // URL has ?transfer but invoke returns null (no transfer data found)
      vi.mocked(invoke).mockResolvedValue(null);

      Object.defineProperty(globalThis, "location", {
        value: { search: "?transfer=true" },
        writable: true,
        configurable: true,
      });

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await vi.advanceTimersByTimeAsync(200);

      // invoke was called for claim_tab_transfer (returned null)
      expect(vi.mocked(invoke).mock.calls).toContainEqual(["claim_tab_transfer"]);
      // Should fall through to normal init and create a tab
      expect(mockCreateTab).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("WindowProvider — unhandled init error catch path", () => {
    it("handles unhandled rejection from init() via .catch()", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Make getCurrentWebviewWindow throw on second call (after initial setup)
      // by making rehydrate throw async inside init()
      const { migrateWorkspaceStorage } = await import("@/services/persistence/workspaceStorage");
      let callCount = 0;
      vi.mocked(migrateWorkspaceStorage).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Simulate an async rejection that bubbles out of init()
          // by making it throw synchronously so init() throws
          throw new Error("async boom in init");
        }
      });

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      await vi.advanceTimersByTimeAsync(200);

      expect(mockWindowContextError).toHaveBeenCalledWith(
        expect.stringContaining("Init failed"),
        expect.any(Error),
      );

      errorSpy.mockRestore();
      vi.mocked(migrateWorkspaceStorage).mockImplementation(() => {});
      vi.useRealTimers();
    });
  });

  describe("WindowProvider — cancelled tab:transfer listener path", () => {
    it("calls unlisten immediately when component unmounts before listener resolves", async () => {
      // Use a deferred promise so the listen promise resolves AFTER unmount
      let resolveTransfer!: (fn: () => void) => void;
      const transferListenPromise = new Promise<() => void>((resolve) => {
        resolveTransfer = resolve;
      });

      const unlistenFn = vi.fn();

      mockListen.mockImplementation((event: string) => {
        if (event === "tab:transfer") return transferListenPromise;
        return Promise.resolve(vi.fn());
      });

      const { unmount } = render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      // Unmount once the listener is requested, BEFORE its promise resolves (cancelled = true)
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith("tab:transfer", expect.any(Function));
      });
      unmount();

      // Now resolve the listen promise - the cancelled branch should call fn() immediately
      resolveTransfer(unlistenFn);

      // The unlisten function should have been called because cancelled was true
      await waitFor(() => expect(unlistenFn).toHaveBeenCalled());
    });
  });

  describe("WindowProvider — close_window failure via tab:remove-by-id", () => {
    it("calls windowCloseWarn when close_window invoke fails for doc window", async () => {
      mockWindowLabel = "doc-closefail";
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === "close_window") return Promise.reject(new Error("cannot close"));
        return Promise.resolve(null);
      });
      // No remaining tabs after removal
      mockGetTabsByWindow.mockReturnValue([]);

      render(
        <WindowProvider>
          <div data-testid="child">content</div>
        </WindowProvider>,
      );

      // Find and invoke the tab:remove-by-id handler once it is registered
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith("tab:remove-by-id", expect.any(Function));
      });
      const removeCall = mockListen.mock.calls.find(
        (call: unknown[]) => call[0] === "tab:remove-by-id",
      );
      removeCall![1]({ payload: { requestId: "req-1", tabId: "last-tab", phase: "commit" } });

      const { windowCloseWarn } = await import("../utils/debug");
      await waitFor(() => {
        expect(windowCloseWarn).toHaveBeenCalledWith(
          "Failed to close window:",
          expect.stringMatching(/cannot close|string/),
        );
      });

      vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
    });
  });
});
