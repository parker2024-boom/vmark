// @vitest-environment node
// MCP bridge path guard — store adapter that assembles allowedRoots and
// delegates to the pure path policy. Security: confines bridge file ops to
// the workspace + open-document tree.
// WI-RA18.1 — "open" means a live tab: a document left with no tab does not
// widen what the bridge may read and write.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { collectAllowedRoots, checkBridgePath } from "./bridgePathGuard";

const invokeMock = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

function resetStores() {
  useWorkspaceStore.setState({
    rootPath: null,
    config: null,
    isWorkspaceMode: false,
  });
  useDocumentStore.setState({ documents: {} });
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
}

/** Open a document the way the app does: a live tab and its document. */
function openDoc(filePath: string | null, windowLabel = "main"): string {
  const tabId = useTabStore.getState().createTab(windowLabel, filePath);
  useDocumentStore.getState().initDocument(tabId, "", filePath);
  return tabId;
}

/** A document left behind with no tab — not open, so it grants nothing. */
function leaveOrphan(tabId: string, filePath: string): void {
  useDocumentStore.getState().initDocument(tabId, "", filePath);
}

describe("collectAllowedRoots", () => {
  beforeEach(resetStores);

  it("is empty with no workspace and no open documents", () => {
    expect(collectAllowedRoots()).toEqual([]);
  });

  it("includes the workspace root when in workspace mode", () => {
    useWorkspaceStore.setState({
      rootPath: "/Users/me/project",
      isWorkspaceMode: true,
      config: null,
    });
    expect(collectAllowedRoots()).toContain("/Users/me/project");
  });

  it("ignores rootPath when not in workspace mode", () => {
    useWorkspaceStore.setState({
      rootPath: "/Users/me/project",
      isWorkspaceMode: false,
      config: null,
    });
    expect(collectAllowedRoots()).toEqual([]);
  });

  it("includes the parent directory of every open document", () => {
    openDoc("/Users/me/docs/a.md");
    openDoc("/Users/me/notes/b.md");
    const roots = collectAllowedRoots();
    expect(roots).toContain("/Users/me/docs");
    expect(roots).toContain("/Users/me/notes");
  });

  it("includes documents open in every window", () => {
    openDoc("/Users/me/docs/a.md", "main");
    openDoc("/Users/me/other/b.md", "doc-1");
    expect(collectAllowedRoots().sort()).toEqual(["/Users/me/docs", "/Users/me/other"]);
  });

  it("does not grant the folder of a document that has no live tab", () => {
    openDoc("/Users/me/docs/a.md");
    leaveOrphan("ghost", "/Users/me/secrets/discarded.md");
    expect(collectAllowedRoots()).toEqual(["/Users/me/docs"]);
  });

  it("stops granting a folder once its tab is closed, even while the document remains", () => {
    const tabId = openDoc("/Users/me/docs/a.md");
    useTabStore.getState().closeTab("main", tabId);
    expect(useDocumentStore.getState().documents[tabId]).toBeDefined();
    expect(collectAllowedRoots()).toEqual([]);
  });

  it("skips untitled (null filePath) documents", () => {
    openDoc(null);
    expect(collectAllowedRoots()).toEqual([]);
  });

  it("deduplicates roots shared by workspace and open docs", () => {
    useWorkspaceStore.setState({
      rootPath: "/Users/me/project",
      isWorkspaceMode: true,
      config: null,
    });
    openDoc("/Users/me/project/a.md");
    openDoc("/Users/me/project/b.md");
    const roots = collectAllowedRoots();
    // /Users/me/project (workspace) + /Users/me/project (both parents) → one.
    expect(roots.filter((r) => r === "/Users/me/project")).toHaveLength(1);
  });
});

describe("checkBridgePath", () => {
  beforeEach(() => {
    resetStores();
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  it("rejects any path when nothing is open", async () => {
    expect((await checkBridgePath("/Users/me/.zshenv")).allowed).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("allows a sibling of an open document", async () => {
    openDoc("/Users/me/docs/a.md");
    expect((await checkBridgePath("/Users/me/docs/b.md")).allowed).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("mcp_bridge_check_path", {
      filePath: "/Users/me/docs/b.md",
      allowedRoots: ["/Users/me/docs"],
    });
  });

  it("rejects a path outside the open document's directory", async () => {
    openDoc("/Users/me/docs/a.md");
    expect((await checkBridgePath("/Users/me/.ssh/id_rsa")).allowed).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects a '..' traversal from within an allowed root", async () => {
    openDoc("/Users/me/docs/a.md");
    expect(
      (await checkBridgePath("/Users/me/docs/../.zshenv")).allowed,
    ).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects a path beside an orphaned document", async () => {
    openDoc("/Users/me/docs/a.md");
    leaveOrphan("ghost", "/Users/me/secrets/discarded.md");
    expect((await checkBridgePath("/Users/me/secrets/key.md")).allowed).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // WI-RA26.1 — the Rust guard rejects with a typed CommandError object; its
  // message is the reason, never "[object Object]".
  it("returns a denial carrying the message when the Rust symlink/canonical guard rejects", async () => {
    openDoc("/Users/me/docs/a.md");
    invokeMock.mockRejectedValueOnce({
      code: "permission-denied",
      message: "Path is outside the workspace and open documents",
    });

    const decision = await checkBridgePath("/Users/me/docs/link/secret.md");

    expect(decision).toEqual({
      allowed: false,
      reason: "Path is outside the workspace and open documents",
    });
  });

  it("returns a denial when the invoke itself fails", async () => {
    openDoc("/Users/me/docs/a.md");
    invokeMock.mockRejectedValueOnce(new Error("IPC channel closed"));

    const decision = await checkBridgePath("/Users/me/docs/b.md");

    expect(decision).toEqual({ allowed: false, reason: "IPC channel closed" });
  });

  // Contract pin: the invoke command name and arg KEYS (filePath, allowedRoots)
  // are bound to the Rust mcp_bridge_check_path params (file_path, allowed_roots)
  // by Tauri's camelCase→snake_case convention. Renaming either side silently
  // breaks the bridge at runtime — nothing else catches it. This pins the JS
  // half; see src-tauri/src/mcp_bridge/path_guard.rs module header for the Rust
  // half. The runtime camelCase↔snake_case binding itself is E2E-only.
  it("pins the mcp_bridge_check_path invoke contract (command + arg keys)", async () => {
    openDoc("/Users/me/docs/a.md");

    await checkBridgePath("/Users/me/docs/b.md");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0] as [string, object];
    expect(command).toBe("mcp_bridge_check_path");
    expect(Object.keys(args).sort()).toEqual(["allowedRoots", "filePath"]);
  });
});
