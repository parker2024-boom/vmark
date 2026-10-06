/**
 * WindowContext — a workspace a window STARTS on is re-granted before it is
 * first read (audit F2 #38).
 *
 * Launch re-grants the recorded roots within a bounded wait, and a root still
 * resolving at the deadline — a slow mount — is granted late, by its worker.
 * A window restored onto that root used to open it straight away, and the
 * file tree and restored tabs read a folder the fs scope did not cover yet:
 * `forbidden path`, until the grant happened to land. The window now asks
 * Rust for the grant and waits for the answer before anything reads the tree.
 *
 * Every mock is a module boundary WindowContext imports; the grant is a
 * deferred `invoke` so a test can hold it pending. Startup file opening and the
 * open policy (which derives a file's workspace) run for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const { mockInvoke, mockOpenWorkspaceWithConfig } = vi.hoisted(() => ({
  mockInvoke: vi.fn((_cmd: string, _args?: unknown): Promise<unknown> => Promise.resolve(null)),
  mockOpenWorkspaceWithConfig: vi.fn(
    (_root: string, _options?: unknown): Promise<null> => Promise.resolve(null),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    emit: vi.fn(() => Promise.resolve()),
    listen: vi.fn(() => Promise.resolve(() => {})),
  }),
}));
vi.mock("@/services/workspaces/openWorkspaceWithConfig", () => ({
  openWorkspaceWithConfig: mockOpenWorkspaceWithConfig,
}));
vi.mock("@/services/workspaces/workspaceWindowActions", () => ({
  claimWorkspaceTransferForWindow: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("./tabTransferHandlers", () => ({
  applyTabTransferData: vi.fn(),
  handleTabTransfer: vi.fn(() => Promise.resolve(false)),
  handleTabRemovalRequest: vi.fn(),
}));
vi.mock("@/services/persistence/windowBrowserSession", () => ({
  restoreWindowBrowserSession: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceSync", () => ({ useWorkspaceSync: vi.fn() }));

import { WindowProvider } from "./WindowContext";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";

const SLOW_ROOT = "/Volumes/slow/proj";

function startWith(search: string): void {
  Object.defineProperty(globalThis, "location", {
    value: { search },
    writable: true,
    configurable: true,
  });
  render(
    <WindowProvider>
      <div />
    </WindowProvider>,
  );
}

/** Hold `allow_workspace_access` pending; resolve it with `release()`. */
function holdTheGrant(): { release: (answer?: unknown) => void } {
  let release!: (answer?: unknown) => void;
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "allow_workspace_access"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(null),
  );
  return { release: (answer = SLOW_ROOT) => release(answer) };
}

/** Let every pending microtask and timer-free promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockImplementation(() => Promise.resolve(null));
  // Startup opening is real, so a file an earlier case opened is a real tab —
  // and a window that already has tabs skips its startup init entirely.
  useTabStore.getState().removeWindow("main");
  for (const id of Object.keys(useDocumentStore.getState().documents)) {
    useDocumentStore.getState().removeDocument(id);
  }
});

describe("a window restored onto a workspace waits for its grant (#38)", () => {
  it("does not open the workspace from its URL until the grant lands", async () => {
    const grant = holdTheGrant();

    startWith(`?workspaceRoot=${encodeURIComponent(SLOW_ROOT)}`);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("allow_workspace_access", { path: SLOW_ROOT }),
    );
    await settle();
    expect(mockOpenWorkspaceWithConfig).not.toHaveBeenCalled();

    grant.release();

    await waitFor(() =>
      expect(mockOpenWorkspaceWithConfig).toHaveBeenCalledWith(SLOW_ROOT, { windowLabel: "main" }),
    );
  });

  it("does the same for the workspace derived from the file it opens", async () => {
    // The real open policy derives the workspace from the file's folder.
    const grant = holdTheGrant();

    startWith(`?file=${encodeURIComponent(`${SLOW_ROOT}/README.md`)}`);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("allow_workspace_access", { path: SLOW_ROOT }),
    );
    await settle();
    expect(mockOpenWorkspaceWithConfig).not.toHaveBeenCalled();

    grant.release();

    await waitFor(() =>
      expect(mockOpenWorkspaceWithConfig).toHaveBeenCalledWith(SLOW_ROOT, { windowLabel: "main" }),
    );
  });

  // A root the static scope already covers is not on the list, so Rust
  // refuses it — the ordinary answer, and never a reason not to open.
  it("still opens a workspace whose grant is refused or fails", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "allow_workspace_access"
        ? Promise.reject({ code: "permission-denied", message: "not granted" })
        : Promise.resolve(null),
    );

    startWith(`?workspaceRoot=${encodeURIComponent("/Users/me/notes")}`);

    await waitFor(() =>
      expect(mockOpenWorkspaceWithConfig).toHaveBeenCalledWith("/Users/me/notes", {
        windowLabel: "main",
      }),
    );
  });
});
