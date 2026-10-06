// WI-RA14E.1 — WindowProvider opens its launch files and workspace through the real pipeline.
//
// What a starting window opens — the `file`, `files` and `workspaceRoot` URL
// params — runs here end to end: the real startup opener, the real
// open-in-new-tab core, the real open policy that derives a file's workspace,
// and the real tab, document, recent-files and workspace stores. Only the
// Tauri boundary (window handle, `invoke`, `readFile`) and the toast
// package are replaced. These cases used to live in WindowContext.test.tsx
// against a hand-written copy of the startup opener, which had drifted: it
// left an empty document behind for a file that failed to read, where the real
// opener detaches the failed tab.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const boundary = vi.hoisted(() => ({
  label: "main",
  files: new Map<string, string>(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: boundary.label,
    emit: vi.fn(() => Promise.resolve()),
    listen: vi.fn(() => Promise.resolve(() => {})),
    close: vi.fn(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/plugin-fs", async () => {
  const { fileBytes } = await import("@/test/fileBytes");
  // Documents are read as bytes (plugin-fs `readTextFile` drops a BOM), so the
  // boundary serves the stored text as the bytes the real `readFile` returns.
  return {
    readFile: vi.fn((path: string) => {
      const content = boundary.files.get(path);
      return content === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : fileBytes(content);
    }),
    exists: vi.fn(() => Promise.resolve(false)),
  };
});
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { toast } from "sonner";
import { WindowProvider } from "./WindowContext";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useRecentFilesStore, useWorkspaceStore } from "@/stores/workspaceStore";
import { useUIStore } from "@/stores/uiStore";

function start(search: string, label = "main") {
  boundary.label = label;
  Object.defineProperty(globalThis, "location", {
    value: { search },
    writable: true,
    configurable: true,
  });
  render(
    <WindowProvider>
      <div data-testid="child">content</div>
    </WindowProvider>,
  );
}

const filesParam = (paths: string[]) => `?files=${encodeURIComponent(JSON.stringify(paths))}`;

const tabsOf = (label: string) => useTabStore.getState().getTabsByWindow(label);
const tabPaths = (label: string) => tabsOf(label).map((t) => (t.kind === "document" ? t.filePath : null));
const docOf = (tabId: string) => useDocumentStore.getState().documents[tabId];

function resetStores() {
  for (const label of ["main", "doc-ext"]) useTabStore.getState().removeWindow(label);
  for (const id of Object.keys(useDocumentStore.getState().documents)) {
    useDocumentStore.getState().removeDocument(id);
  }
  useRecentFilesStore.setState({ files: [] });
  useWorkspaceStore.setState({ rootPath: null, isWorkspaceMode: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.files.clear();
  resetStores();
});

describe("WindowProvider — launch files from URL params", () => {
  it("opens the `file` param into a tab with its content and records it as recent", async () => {
    boundary.files.set("/docs/test.md", "# File Content");

    start("?file=/docs/test.md");

    await waitFor(() => expect(tabPaths("main")).toEqual(["/docs/test.md"]));
    await waitFor(() => expect(docOf(tabsOf("main")[0].id)?.content).toBe("# File Content"));
    expect(docOf(tabsOf("main")[0].id)?.filePath).toBe("/docs/test.md");
    expect(useRecentFilesStore.getState().files.map((f) => f.path)).toContain("/docs/test.md");
  });

  it("falls back to one blank tab, and says so, when the only file cannot be read", async () => {
    start("?file=/docs/missing.md");

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(tabPaths("main")).toEqual([null]));
    expect(docOf(tabsOf("main")[0].id)?.content).toBe("");
  });

  it("opens every file of the `files` param, in order", async () => {
    boundary.files.set("/docs/a.md", "# a");
    boundary.files.set("/docs/b.md", "# b");

    start(filesParam(["/docs/a.md", "/docs/b.md"]));

    await waitFor(() => expect(tabPaths("main")).toEqual(["/docs/a.md", "/docs/b.md"]));
  });

  it("drops an unreadable file from a multi-file launch and keeps the rest — no blank stand-in", async () => {
    boundary.files.set("/docs/good.md", "# good content");

    start(filesParam(["/docs/good.md", "/docs/bad.md"]));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(tabPaths("main")).toEqual(["/docs/good.md"]));
    expect(docOf(tabsOf("main")[0].id)?.content).toBe("# good content");
  });

  it("treats a malformed `files` param as absent: the launch window opens no tab", async () => {
    start("?files=not-json");

    await waitFor(() => expect(screen.getByTestId("child")).toBeInTheDocument());
    expect(tabsOf("main")).toEqual([]);
  });
});

describe("WindowProvider — the workspace a launch lands in", () => {
  it("opens `workspaceRoot` and still opens the `file` beside it", async () => {
    boundary.files.set("/projects/myapp/README.md", "# README");

    start("?workspaceRoot=/projects/myapp&file=/projects/myapp/README.md");

    await waitFor(() => expect(useWorkspaceStore.getState().rootPath).toBe("/projects/myapp"));
    await waitFor(() => expect(tabPaths("main")).toEqual(["/projects/myapp/README.md"]));
    expect(docOf(tabsOf("main")[0].id)?.content).toBe("# README");
  });

  it("opens a workspace with no file and creates no blank tab", async () => {
    start("?workspaceRoot=/projects/myapp");

    await waitFor(() => expect(useWorkspaceStore.getState().rootPath).toBe("/projects/myapp"));
    expect(tabsOf("main")).toEqual([]);
  });

  it("reveals the file explorer when it opens a workspace (#1005)", async () => {
    useUIStore.setState({ sidebarVisible: false, sidebarViewMode: "outline" });

    start("?workspaceRoot=/projects/myapp");

    await waitFor(() => {
      expect(useUIStore.getState().sidebarVisible).toBe(true);
      expect(useUIStore.getState().sidebarViewMode).toBe("files");
    });
  });

  it("derives the workspace from the file's folder when none is active", async () => {
    boundary.files.set("/docs/test.md", "# content");

    start("?file=/docs/test.md");

    await waitFor(() => expect(useWorkspaceStore.getState().rootPath).toBe("/docs"));
  });

  it("keeps the active workspace when the file is inside it", async () => {
    useWorkspaceStore.setState({ rootPath: "/projects", isWorkspaceMode: true });
    boundary.files.set("/projects/src/test.md", "# Inside workspace");

    start("?file=/projects/src/test.md");

    await waitFor(() => expect(tabPaths("main")).toEqual(["/projects/src/test.md"]));
    expect(useWorkspaceStore.getState().rootPath).toBe("/projects");
    expect(useWorkspaceStore.getState().isWorkspaceMode).toBe(true);
  });

  it("leaves the launch window with no workspace when the file's folder is no root (a drive root)", async () => {
    useWorkspaceStore.setState({ rootPath: "/stale", isWorkspaceMode: true });
    boundary.files.set("C:\\orphan.md", "# content");

    start("?file=C:\\orphan.md");

    await waitFor(() => expect(useWorkspaceStore.getState().rootPath).toBeNull());
    expect(useWorkspaceStore.getState().isWorkspaceMode).toBe(false);
  });

  it("does not close a secondary window's workspace when the file's folder is no root", async () => {
    useWorkspaceStore.setState({ rootPath: "/kept", isWorkspaceMode: true });
    boundary.files.set("C:\\external.md", "# External");

    start("?file=C:\\external.md", "doc-ext");

    await waitFor(() => expect(tabPaths("doc-ext")).toEqual(["C:\\external.md"]));
    expect(useWorkspaceStore.getState().rootPath).toBe("/kept");
  });
});
