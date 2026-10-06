// @vitest-environment node
// WI-RA1B.1 — per-tab state cleanup is a CONSEQUENCE of a tab leaving the tab
// store, not something each removal site has to remember. Pins the removal-bus
// subscriber (`startTabStateCleanup`) against the real stores, including the
// invariant: after any sequence of removals, every document in the document
// store belongs to a live tab.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore, useRevisionStore } from "@/stores/documentStore";
import { onTabRemoved } from "@/stores/tabRemovalBus";
import {
  getEditorScrollOffset,
  setEditorScrollOffset,
} from "@/services/editor/scrollPosition";
import { startTabStateCleanup } from "./tabCleanup";

const MAIN = "main";
const OTHER = "doc-1";

function resetStores(): void {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useDocumentStore.setState({ documents: {} });
  useRevisionStore.setState({ revisions: {} });
}

/** A document tab with real document state behind it. */
function openTab(windowLabel: string, filePath: string | null, content = "body"): string {
  const tabId = useTabStore.getState().createTab(windowLabel, filePath);
  useDocumentStore.getState().initDocument(tabId, content, filePath);
  return tabId;
}

function liveTabIds(): Set<string> {
  return new Set(
    Object.values(useTabStore.getState().tabs).flatMap((tabs) => tabs.map((t) => t.id)),
  );
}

/** Document ids with no live tab — the defect this work item removes. */
function orphanDocumentIds(): string[] {
  const live = liveTabIds();
  return Object.keys(useDocumentStore.getState().documents).filter((id) => !live.has(id));
}

let stopCleanup: () => void;

beforeEach(() => {
  resetStores();
  stopCleanup = startTabStateCleanup();
});

afterEach(() => {
  stopCleanup();
});

describe("startTabStateCleanup — every removal frees the tab's state", () => {
  it("closeTab leaves no document behind", () => {
    const tabId = openTab(MAIN, "/repo/a.md");
    useDocumentStore.getState().setEditorContent(tabId, "discarded edits");

    expect(useTabStore.getState().closeTab(MAIN, tabId)).toBe(true);

    expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
    expect(orphanDocumentIds()).toEqual([]);
  });

  it("detachTab leaves no document behind", () => {
    const tabId = openTab(MAIN, "/repo/a.md");

    useTabStore.getState().detachTab(MAIN, tabId);

    expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
  });

  it("removeWindow frees every tab the window held, pinned ones included", () => {
    const pinned = openTab(MAIN, "/repo/pinned.md");
    const plain = openTab(MAIN, null, "untitled draft");
    useTabStore.getState().togglePin(MAIN, pinned);
    const survivor = openTab(OTHER, "/repo/other.md");

    useTabStore.getState().removeWindow(MAIN);

    expect(useDocumentStore.getState().getDocument(pinned)).toBeUndefined();
    expect(useDocumentStore.getState().getDocument(plain)).toBeUndefined();
    // Another window's tab is not this window's to clean.
    expect(useDocumentStore.getState().getDocument(survivor)?.content).toBe("body");
  });

  it("frees the per-tab state that lives outside the document store too", () => {
    const tabId = openTab(MAIN, "/repo/a.md");
    const keep = openTab(MAIN, "/repo/b.md");
    setEditorScrollOffset(tabId, "wysiwyg", 320);
    setEditorScrollOffset(keep, "wysiwyg", 64);

    useTabStore.getState().closeTab(MAIN, tabId);

    expect(getEditorScrollOffset(tabId, "wysiwyg")).toBeUndefined();
    // A closing tab takes nothing of its neighbour's with it.
    expect(getEditorScrollOffset(keep, "wysiwyg")).toBe(64);
  });

  it("a refused close (pinned tab) keeps the document of the tab still on screen", () => {
    const tabId = openTab(MAIN, "/repo/pinned.md", "kept");
    useTabStore.getState().togglePin(MAIN, tabId);

    expect(useTabStore.getState().closeTab(MAIN, tabId)).toBe(false);

    expect(useDocumentStore.getState().getDocument(tabId)?.content).toBe("kept");
  });

  it("closing an unknown tab id touches no document", () => {
    const tabId = openTab(MAIN, "/repo/a.md", "kept");

    expect(useTabStore.getState().closeTab(MAIN, "no-such-tab")).toBe(false);
    useTabStore.getState().detachTab(MAIN, "no-such-tab");

    expect(useDocumentStore.getState().getDocument(tabId)?.content).toBe("kept");
  });

  it("is idempotent across rapid repeats of the same removal", () => {
    const tabId = openTab(MAIN, "/repo/a.md");
    const keep = openTab(MAIN, "/repo/b.md", "kept");

    useTabStore.getState().closeTab(MAIN, tabId);
    useTabStore.getState().closeTab(MAIN, tabId);
    useTabStore.getState().detachTab(MAIN, tabId);

    expect(orphanDocumentIds()).toEqual([]);
    expect(useDocumentStore.getState().getDocument(keep)?.content).toBe("kept");
  });
});

describe("startTabStateCleanup — a tab that moved keeps its document", () => {
  it("a tab transferred into another window before the source detaches keeps its state", () => {
    const tabId = openTab(MAIN, "/repo/moved.md", "travels with the tab");
    useDocumentStore.getState().setEditorContent(tabId, "unsaved, travels too");

    // The destination applies the transfer (same id), then the source lets go.
    useTabStore.getState().createTransferredTab(OTHER, {
      id: tabId,
      filePath: "/repo/moved.md",
      title: "moved.md",
      isPinned: false,
    });
    useTabStore.getState().detachTab(MAIN, tabId);

    const doc = useDocumentStore.getState().getDocument(tabId);
    expect(doc?.content).toBe("unsaved, travels too");
    expect(doc?.isDirty).toBe(true);
    expect(useTabStore.getState().findTabById(tabId)).not.toBeNull();
  });

  it("the tab's state goes once the last window holding it lets go", () => {
    const tabId = openTab(MAIN, "/repo/moved.md");
    useTabStore.getState().createTransferredTab(OTHER, {
      id: tabId,
      filePath: "/repo/moved.md",
      title: "moved.md",
      isPinned: false,
    });
    useTabStore.getState().detachTab(MAIN, tabId);

    useTabStore.getState().closeTab(OTHER, tabId);

    expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
  });
});

describe("startTabStateCleanup — lifetime", () => {
  it("the disposer removes exactly its own listener", () => {
    const seen: string[] = [];
    const offProbe = onTabRemoved((_w, tabId) => seen.push(tabId));
    const tabId = openTab(MAIN, "/repo/a.md", "kept after stop");

    stopCleanup();
    useTabStore.getState().closeTab(MAIN, tabId);
    offProbe();

    // The bus still delivered to the other subscriber; only cleanup stopped.
    expect(seen).toEqual([tabId]);
    expect(useDocumentStore.getState().getDocument(tabId)?.content).toBe("kept after stop");
  });

  it("starting twice and stopping once still cleans up", () => {
    const stopSecond = startTabStateCleanup();
    const tabId = openTab(MAIN, "/repo/a.md");

    stopSecond();
    useTabStore.getState().closeTab(MAIN, tabId);

    expect(useDocumentStore.getState().getDocument(tabId)).toBeUndefined();
  });
});

type Step =
  | { kind: "open"; window: number; titled: boolean }
  | { kind: "close"; window: number; index: number }
  | { kind: "detach"; window: number; index: number }
  | { kind: "pin"; window: number; index: number }
  | { kind: "transfer"; window: number; index: number }
  | { kind: "removeWindow"; window: number };

const WINDOWS = [MAIN, OTHER, "doc-2"] as const;

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("open" as const), window: fc.nat(2), titled: fc.boolean() }),
  fc.record({ kind: fc.constant("close" as const), window: fc.nat(2), index: fc.nat(5) }),
  fc.record({ kind: fc.constant("detach" as const), window: fc.nat(2), index: fc.nat(5) }),
  fc.record({ kind: fc.constant("pin" as const), window: fc.nat(2), index: fc.nat(5) }),
  fc.record({ kind: fc.constant("transfer" as const), window: fc.nat(2), index: fc.nat(5) }),
  fc.record({ kind: fc.constant("removeWindow" as const), window: fc.nat(2) }),
);

describe("invariant — every document belongs to a live tab", () => {
  it("holds after any sequence of opens, closes, detaches, transfers and window teardowns", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), (steps) => {
        resetStores();
        let serial = 0;
        for (const step of steps) {
          const windowLabel = WINDOWS[step.window];
          const tabs = useTabStore.getState().tabs[windowLabel] ?? [];
          const target = "index" in step ? tabs[step.index % Math.max(tabs.length, 1)] : undefined;
          switch (step.kind) {
            case "open":
              serial += 1;
              // CJK in the path and body: ids, not names, key the state.
              openTab(windowLabel, step.titled ? `/repo/文档-${serial}.md` : null, `正文 ${serial}`);
              break;
            case "close":
              if (target) useTabStore.getState().closeTab(windowLabel, target.id);
              break;
            case "detach":
              if (target) useTabStore.getState().detachTab(windowLabel, target.id);
              break;
            case "pin":
              if (target) useTabStore.getState().togglePin(windowLabel, target.id);
              break;
            case "transfer": {
              if (!target || target.kind !== "document") break;
              const destination = WINDOWS[(step.window + 1) % WINDOWS.length];
              useTabStore.getState().createTransferredTab(destination, {
                id: target.id,
                filePath: target.filePath,
                title: target.title,
                isPinned: false,
              });
              useTabStore.getState().detachTab(windowLabel, target.id);
              break;
            }
            case "removeWindow":
              useTabStore.getState().removeWindow(windowLabel);
              break;
          }
          expect(orphanDocumentIds()).toEqual([]);
          // …and cleanup never takes the document of a tab still on screen.
          const documents = useDocumentStore.getState().documents;
          for (const id of liveTabIds()) expect(documents[id]).toBeDefined();
        }
      }),
      { numRuns: 200 },
    );
  });
});
