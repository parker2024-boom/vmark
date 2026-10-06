// vmark.workspace.save_as — the policy this handler owns: argument
// validation, tab resolution, the path-scope guard, the auto-approve gate and
// overwrite protection.
//
// Real handler, real stores, real save pipeline, over the stateful disk fake:
// "nothing was written" is read off the disk, not off a mocked writer. What a
// successful save_as puts on disk and how it is ordered with other saves is
// covered in mcpSavePipeline.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () =>
  (await import("./bridgeWriteGate")).gatedFsModule(),
);
vi.mock("@tauri-apps/api/core", async () =>
  (await import("./bridgeWriteGate")).gatedCoreModule(),
);

import { statefulFs } from "@/test/statefulFsFake";
import { ROOT, WINDOW, doc, editDoc, newUntitledTab, openDocInTab } from "@/test/tier0/harness";
import { useDocumentStore } from "@/stores/documentStore";
import { useTabStore } from "@/stores/tabStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { imeToast } from "@/services/ime/imeToast";
import { handleWorkspaceSaveAs } from "@/services/mcpBridge/v2/workspaceSaveAs";
import {
  resetBridge,
  responseTo,
  setAutoApproveEdits,
  structuredErrorOf,
} from "./bridgeDiskHarness";
import { duringExistsProbe } from "./bridgeWriteGate";

const ORIGINAL = `${ROOT}/original.md`;
const VICTIM = `${ROOT}/victim.md`;
const FRESH = `${ROOT}/fresh.md`;
/** Outside the workspace root and every open document's folder. */
const OUT_OF_SCOPE = "/Users/someone/.zshenv";

let guardChecks: string[];
let warningToast: ReturnType<typeof vi.spyOn>;

/** Every application write that did not go to the app's own data folder. */
function documentWrites() {
  return statefulFs.writes.filter((w) => w.path.startsWith(`${ROOT}/`) || !w.path.startsWith("/Users/test/"));
}

beforeEach(() => {
  resetBridge();
  guardChecks = [];
  statefulFs.stubCommand("mcp_bridge_check_path", (args) => {
    guardChecks.push(String(args.filePath));
  });
  warningToast = vi.spyOn(imeToast, "warning").mockImplementation(() => "toast-id");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("save_as argument validation", () => {
  it.each([
    { label: "missing", args: {} },
    { label: "empty string", args: { filePath: "" } },
    { label: "non-string", args: { filePath: 42 } },
  ])("rejects a $label filePath before consulting the guard or the disk", async ({ args }) => {
    const tabId = newUntitledTab();
    editDoc(tabId, "draft\n");

    await handleWorkspaceSaveAs("req-v", args as Record<string, unknown>);

    expect(structuredErrorOf(responseTo("req-v"))).toEqual({
      error: "INVALID_PATH",
      message: "filePath must be a non-empty string",
    });
    expect(guardChecks).toEqual([]);
    expect(documentWrites()).toEqual([]);
  });
});

describe("save_as tab resolution", () => {
  it("rejects an explicit tabId that matches no open tab", async () => {
    newUntitledTab();

    await handleWorkspaceSaveAs("req-t1", { tabId: "ghost-tab", filePath: FRESH });

    expect(structuredErrorOf(responseTo("req-t1"))).toEqual({
      error: "INVALID_TAB",
      message: "Unknown tabId",
    });
    expect(documentWrites()).toEqual([]);
  });

  it("rejects when no tabId is given and no tab is focused", async () => {
    await handleWorkspaceSaveAs("req-t2", { filePath: FRESH });

    expect(structuredErrorOf(responseTo("req-t2"))).toEqual({
      error: "INVALID_TAB",
      message: "No focused tab",
    });
    expect(documentWrites()).toEqual([]);
  });

  it("rejects a tab that has no backing document", async () => {
    useTabStore.setState({
      tabs: { [WINDOW]: [{ kind: "document", id: "orphan", filePath: null, title: "t", isPinned: false, formatId: "markdown" }] },
      activeTabId: { [WINDOW]: "orphan" },
    });

    await handleWorkspaceSaveAs("req-t3", { tabId: "orphan", filePath: FRESH });

    expect(structuredErrorOf(responseTo("req-t3"))).toEqual({
      error: "INVALID_TAB",
      message: "No document for tab",
    });
    expect(documentWrites()).toEqual([]);
  });

  it("refuses when the tab is closed while the overwrite probe is in flight", async () => {
    // The handler awaits between resolving the tab and saving it. A document
    // that has gone by then must not be written out from a stale copy.
    const tabId = await openDocInTab(ORIGINAL, "body\n");
    duringExistsProbe(FRESH, () => {
      useDocumentStore.getState().removeDocument(tabId);
    });

    await handleWorkspaceSaveAs("req-closed", { tabId, filePath: FRESH });

    expect(structuredErrorOf(responseTo("req-closed"))).toEqual({
      error: "INVALID_TAB",
      message: "No document for tab",
    });
    expect(statefulFs.has(FRESH)).toBe(false);
  });

  it("falls back to the focused tab when no tabId is supplied", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, "body\n");

    await handleWorkspaceSaveAs("req-t4", { filePath: FRESH });

    expect(responseTo("req-t4").success).toBe(true);
    expect(statefulFs.read(FRESH)).toBe("body\n");
    expect(doc(tabId).filePath).toBe(FRESH);
  });
});

describe("save_as path-scope guard", () => {
  it("refuses a path outside the workspace and open documents, and writes nothing", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, "payload\n");

    await handleWorkspaceSaveAs("req-evil", { tabId, filePath: OUT_OF_SCOPE });

    expect(structuredErrorOf(responseTo("req-evil"))?.error).toBe("INVALID_PATH");
    expect(statefulFs.has(OUT_OF_SCOPE)).toBe(false);
    expect(documentWrites()).toEqual([]);
    expect(doc(tabId).filePath).toBeNull();
  });

  it("refuses a path the symlink check rejects, even though it looks in scope", async () => {
    const tabId = newUntitledTab();
    editDoc(tabId, "payload\n");
    statefulFs.stubCommand("mcp_bridge_check_path", () => {
      throw new Error("path resolves outside the allowed roots");
    });

    await handleWorkspaceSaveAs("req-link", { tabId, filePath: FRESH });

    expect(structuredErrorOf(responseTo("req-link"))).toEqual({
      error: "INVALID_PATH",
      message: "path resolves outside the allowed roots",
    });
    expect(statefulFs.has(FRESH)).toBe(false);
  });

  it("answers INVALID_PATH, not APPROVAL_REQUIRED, when a refused path also exists", async () => {
    // The existence probe must not run for a path the guard refused: a
    // different answer for an existing file would let a client map the disk.
    await openDocInTab(ORIGINAL, "body\n");
    statefulFs.seed(OUT_OF_SCOPE, "export SECRET=1\n");

    await handleWorkspaceSaveAs("req-order", { filePath: OUT_OF_SCOPE });

    expect(structuredErrorOf(responseTo("req-order"))?.error).toBe("INVALID_PATH");
    expect(statefulFs.read(OUT_OF_SCOPE)).toBe("export SECRET=1\n");
  });
});

describe("save_as auto-approve gate", () => {
  it("blocks a NEW location with APPROVAL_REQUIRED and a toast when auto-approve is off", async () => {
    const tabId = await openDocInTab(ORIGINAL, "hi\n");
    setAutoApproveEdits(false);

    await handleWorkspaceSaveAs("req-gate", { tabId, filePath: FRESH });

    expect(structuredErrorOf(responseTo("req-gate"))?.error).toBe("APPROVAL_REQUIRED");
    expect(statefulFs.has(FRESH)).toBe(false);
    expect(doc(tabId).filePath).toBe(ORIGINAL);
    expect(warningToast).toHaveBeenCalledTimes(1);
    expect(String(warningToast.mock.calls[0][0])).toContain("fresh.md");
  });

  it("allows the tab's OWN path with auto-approve off — that is a save, not a new location", async () => {
    const tabId = await openDocInTab(ORIGINAL, "hi\n");
    editDoc(tabId, "hi again\n");
    setAutoApproveEdits(false);

    await handleWorkspaceSaveAs("req-own", { tabId, filePath: ORIGINAL });

    expect(responseTo("req-own").success).toBe(true);
    expect(statefulFs.read(ORIGINAL)).toBe("hi again\n");
    expect(warningToast).not.toHaveBeenCalled();
  });

  it("allows a new location when auto-approve is on", async () => {
    const tabId = await openDocInTab(ORIGINAL, "hello\n");

    await handleWorkspaceSaveAs("req-on", { tabId, filePath: FRESH });

    expect(responseTo("req-on").success).toBe(true);
    expect(statefulFs.read(FRESH)).toBe("hello\n");
    // The original is left as it was: Save As copies, it does not move.
    expect(statefulFs.read(ORIGINAL)).toBe("hello\n");
  });

  it("names the whole path in the toast when the path has no filename component", async () => {
    // Only a filesystem root has no basename, and it is in scope only when
    // the root itself is the open workspace.
    const tabId = await openDocInTab(ORIGINAL, "hi\n");
    useWorkspaceStore.setState({ rootPath: "/", isWorkspaceMode: true });
    setAutoApproveEdits(false);

    await handleWorkspaceSaveAs("req-noname", { tabId, filePath: "/" });

    expect(structuredErrorOf(responseTo("req-noname"))?.error).toBe("APPROVAL_REQUIRED");
    expect(String(warningToast.mock.calls[0][0])).toContain("save to a new location: /.");
  });
});

// `autoApproveEdits` authorises saving to a NEW location. It must not
// authorise destroying an EXISTING distinct file: the bridge's allowed roots
// include the parent directory of every open document, so an auto-approved
// save_as could silently overwrite any sibling of any open file.
describe("save_as overwrite protection", () => {
  it("refuses to clobber an existing distinct file even when auto-approve is on", async () => {
    const tabId = await openDocInTab(ORIGINAL, "body\n");
    statefulFs.seed(VICTIM, "someone else's work\n");

    await handleWorkspaceSaveAs("req-clobber", { tabId, filePath: VICTIM });

    const err = structuredErrorOf(responseTo("req-clobber"));
    expect(err?.error).toBe("APPROVAL_REQUIRED");
    // Names the file that would be destroyed so the agent can report it.
    expect(err?.message).toContain("victim.md");
    expect(statefulFs.read(VICTIM)).toBe("someone else's work\n");
    expect(doc(tabId).filePath).toBe(ORIGINAL);
  });

  it("names the whole path in the refusal when the path has no filename component", async () => {
    const tabId = await openDocInTab(ORIGINAL, "body\n");
    useWorkspaceStore.setState({ rootPath: "/", isWorkspaceMode: true });

    await handleWorkspaceSaveAs("req-dir", { tabId, filePath: "/" });

    const err = structuredErrorOf(responseTo("req-dir"));
    expect(err?.error).toBe("APPROVAL_REQUIRED");
    expect(err?.message).toContain("Refusing to overwrite the existing file /.");
    expect(documentWrites()).toEqual([]);
  });

  it("still allows save_as to the tab's own path when the file exists", async () => {
    // Saving over yourself is a save, not a clobber.
    const tabId = await openDocInTab(ORIGINAL, "body\n");
    editDoc(tabId, "body, edited\n");

    await handleWorkspaceSaveAs("req-self", { tabId, filePath: ORIGINAL });

    expect(responseTo("req-self").success).toBe(true);
    expect(statefulFs.read(ORIGINAL)).toBe("body, edited\n");
  });

  it("allows save_as to a genuinely new path", async () => {
    const tabId = await openDocInTab(ORIGINAL, "body\n");

    await handleWorkspaceSaveAs("req-new", { tabId, filePath: FRESH });

    expect(responseTo("req-new").success).toBe(true);
    expect(statefulFs.read(FRESH)).toBe("body\n");
    expect(doc(tabId).filePath).toBe(FRESH);
  });
});
