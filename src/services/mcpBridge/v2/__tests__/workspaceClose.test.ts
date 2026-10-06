// @vitest-environment node
// WI-RA1B.1 — `vmark.workspace.close` reports what the tab store DID, not what
// the handler asked for: a pinned tab the store refuses to close is not
// `closed: true`, and a tab that did close takes its document with it. Own file
// because workspace.test.ts sits at its frozen size baseline.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { startTabStateCleanup } from "@/services/windowClose/tabCleanup";
import { handleWorkspaceClose } from "@/services/mcpBridge/v2/workspace";

const MAIN = "main";

/** The reply the handler sent back across the bridge for request `id`. */
function replyTo(id: string): { success: boolean; data?: unknown; error?: string } {
  const call = vi
    .mocked(invoke)
    .mock.calls.findLast(
      ([command, args]) =>
        command === "mcp_bridge_respond" &&
        (args as { payload: { id: string } }).payload.id === id,
    );
  if (!call) throw new Error(`no bridge reply for ${id}`);
  return (call[1] as { payload: { success: boolean; data?: unknown; error?: string } }).payload;
}

function openTab(filePath: string | null, content: string): string {
  const tabId = useTabStore.getState().createTab(MAIN, filePath);
  useDocumentStore.getState().initDocument(tabId, content, filePath);
  return tabId;
}

let stopCleanup: () => void;

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
  stopCleanup = startTabStateCleanup();
});

afterEach(() => {
  stopCleanup();
});

describe("vmark.workspace.close — the reply is the store's verdict", () => {
  it("reports the refusal for a pinned tab and leaves the tab and its document alone", async () => {
    const tabId = openTab("/repo/pinned.md", "pinned body");
    useTabStore.getState().togglePin(MAIN, tabId);

    await handleWorkspaceClose("req-pinned", { tabId });

    expect(replyTo("req-pinned")).toMatchObject({
      success: true,
      data: { closed: false, reason: "PINNED" },
    });
    expect(useTabStore.getState().findTabById(tabId)).not.toBeNull();
    expect(useDocumentStore.getState().getDocument(tabId)?.content).toBe("pinned body");
  });

  it("force does not override a pin, and the dirty buffer survives the refusal", async () => {
    const tabId = openTab("/repo/pinned.md", "saved");
    useDocumentStore.getState().setEditorContent(tabId, "unsaved 修改");
    useTabStore.getState().togglePin(MAIN, tabId);

    await handleWorkspaceClose("req-force", { tabId, force: true });

    expect(replyTo("req-force")).toMatchObject({
      success: true,
      data: { closed: false, reason: "PINNED" },
    });
    const doc = useDocumentStore.getState().getDocument(tabId);
    expect(doc?.content).toBe("unsaved 修改");
    expect(doc?.isDirty).toBe(true);
  });

  it("a pinned dirty tab without force is still refused as DIRTY first", async () => {
    const tabId = openTab("/repo/pinned.md", "saved");
    useDocumentStore.getState().setEditorContent(tabId, "unsaved");
    useTabStore.getState().togglePin(MAIN, tabId);

    await handleWorkspaceClose("req-dirty", { tabId });

    expect(replyTo("req-dirty")).toMatchObject({
      success: true,
      data: { closed: false, reason: "DIRTY" },
    });
  });

  it("reports closed: true once the tab is really gone, and its document with it", async () => {
    const tabId = openTab(null, "");
    useDocumentStore.getState().setEditorContent(tabId, "discarded draft");

    await handleWorkspaceClose("req-close", { tabId, force: true });

    expect(replyTo("req-close")).toMatchObject({ success: true, data: { closed: true } });
    expect(useTabStore.getState().findTabById(tabId)).toBeNull();
    expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
  });

  it("unpinning makes the same close succeed", async () => {
    const tabId = openTab("/repo/pinned.md", "body");
    useTabStore.getState().togglePin(MAIN, tabId);
    await handleWorkspaceClose("req-1", { tabId });
    expect(replyTo("req-1")).toMatchObject({ data: { closed: false, reason: "PINNED" } });

    useTabStore.getState().togglePin(MAIN, tabId);
    await handleWorkspaceClose("req-2", { tabId });

    expect(replyTo("req-2")).toMatchObject({ success: true, data: { closed: true } });
  });
});

// WI-RA1C.5 — a DIVERGENT document is clean, but holds content the user chose
// to keep over an external change ("Keep my changes"). Every human close asks
// about it; an AI close without `force` must not drop it in silence either.
describe("vmark.workspace.close — a divergent document is local content", () => {
  function openDivergent(content: string): string {
    const tabId = openTab("/repo/kept.md", content);
    useDocumentStore.getState().markDivergent(tabId);
    return tabId;
  }

  it("refuses without force, and the tab and the kept content survive", async () => {
    const tabId = openDivergent("我保留的内容\n");

    await handleWorkspaceClose("req-div", { tabId });

    expect(replyTo("req-div")).toMatchObject({
      success: true,
      data: { closed: false, reason: "DIVERGENT" },
    });
    expect(useTabStore.getState().findTabById(tabId)).not.toBeNull();
    const doc = useDocumentStore.getState().getDocument(tabId);
    expect(doc).toMatchObject({ content: "我保留的内容\n", isDirty: false, isDivergent: true });
  });

  it("closes with force, taking the document with it", async () => {
    const tabId = openDivergent("kept\n");

    await handleWorkspaceClose("req-div-force", { tabId, force: true });

    expect(replyTo("req-div-force")).toMatchObject({ success: true, data: { closed: true } });
    expect(useTabStore.getState().findTabById(tabId)).toBeNull();
    expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
  });

  it("a document that is dirty AND divergent is reported as DIRTY", async () => {
    const tabId = openDivergent("kept\n");
    useDocumentStore.getState().setEditorContent(tabId, "kept, then edited\n");

    await handleWorkspaceClose("req-both", { tabId });

    expect(replyTo("req-both")).toMatchObject({ data: { closed: false, reason: "DIRTY" } });
  });

  it("a pinned divergent tab is refused as DIVERGENT first", async () => {
    const tabId = openDivergent("kept\n");
    useTabStore.getState().togglePin(MAIN, tabId);

    await handleWorkspaceClose("req-pin-div", { tabId });

    expect(replyTo("req-pin-div")).toMatchObject({ data: { closed: false, reason: "DIVERGENT" } });
  });
});

// WI-RA1C.6 — the sidecar's tool description is the only place an AI client
// learns what a refused close means. Every reason the handler really answers
// with must be named there, or a client meets a reason it was never told of.
describe("vmark.workspace.close — the sidecar documents every refusal", () => {
  async function reasonFor(setup: (tabId: string) => void): Promise<string> {
    const tabId = openTab("/repo/r.md", "body\n");
    setup(tabId);
    await handleWorkspaceClose("req-reason", { tabId });
    const { data } = replyTo("req-reason") as { data: { closed: boolean; reason?: string } };
    expect(data.closed).toBe(false);
    return data.reason ?? "";
  }

  it("names DIRTY, DIVERGENT and PINNED in the close action's description", async () => {
    const reasons = [
      await reasonFor((tabId) => useDocumentStore.getState().setEditorContent(tabId, "edited\n")),
      await reasonFor((tabId) => useDocumentStore.getState().markDivergent(tabId)),
      await reasonFor((tabId) => useTabStore.getState().togglePin(MAIN, tabId)),
    ];
    expect(reasons).toEqual(["DIRTY", "DIVERGENT", "PINNED"]);

    const tool = readFileSync(
      resolve(import.meta.dirname, "../../../../../server/mcp/src/tools/workspace.ts"),
      "utf8",
    );
    const closeLine = tool.split("\n").find((line) => line.includes("'- close:"));
    expect(closeLine).toBeDefined();
    for (const reason of reasons) expect(closeLine).toContain(`"${reason}"`);
  });
});
