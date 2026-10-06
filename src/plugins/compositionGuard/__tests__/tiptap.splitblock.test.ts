// @vitest-environment node
// Split from tiptap.test.ts per the test-file size gate (WI-7).
// Mocks + the top-level RAF save/restore are replicated (vi.mock is per-module).
/**
 * Tests for compositionGuard tiptap extension — extension metadata,
 * plugin structure, filterTransaction, handleKeyDown, DOM event handlers,
 * and composition state management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock imeGuard before importing the extension
const mockFlushProseMirrorCompositionQueue = vi.fn();
const mockGetImeCleanupPrefixLength = vi.fn((..._args: unknown[]): number | null => 0);
const mockIsImeKeyEvent = vi.fn((..._args: unknown[]) => false);
const mockIsProseMirrorInCompositionGrace = vi.fn((..._args: unknown[]) => false);
const mockMarkProseMirrorCompositionEnd = vi.fn();

vi.mock("@/utils/imeGuard", () => ({
  flushProseMirrorCompositionQueue: (...args: unknown[]) => mockFlushProseMirrorCompositionQueue(...args),
  getImeCleanupPrefixLength: (...args: unknown[]) => mockGetImeCleanupPrefixLength(...args),
  HANGUL_RE: /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/,
  IME_GRACE_PERIOD_MS: 50,
  isImeKeyEvent: (...args: unknown[]) => mockIsImeKeyEvent(...args),
  isProseMirrorInCompositionGrace: (...args: unknown[]) => mockIsProseMirrorInCompositionGrace(...args),
  markProseMirrorCompositionEnd: (...args: unknown[]) => mockMarkProseMirrorCompositionEnd(...args),
}));

// Mock splitBlock from ProseMirror commands (used for Korean deferred Enter)
const mockSplitBlock = vi.fn();
vi.mock("@tiptap/pm/commands", () => ({
  splitBlock: (...args: unknown[]) => mockSplitBlock(...args),
}));

import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { compositionGuardExtension } from "../tiptap";

// Mock requestAnimationFrame to execute callbacks synchronously
const originalRAF = globalThis.requestAnimationFrame;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.requestAnimationFrame = originalRAF;
});

describe("compositionGuard filterTransaction — heading split rejection", () => {
  function getPluginSet() {
    const plugins = compositionGuardExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "compositionGuard",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const plugin = plugins[0] as unknown as {
      props: {
        handleDOMEvents: Record<string, (view: unknown, event?: unknown) => boolean>;
      };
      spec: {
        filterTransaction: (tr: unknown) => boolean;
      };
    };
    return {
      events: plugin.props.handleDOMEvents,
      filterTransaction: plugin.spec.filterTransaction,
    };
  }

  it("rejects heading→paragraph split transaction during composing", () => {
    const { events, filterTransaction } = getPluginSet();
    // The composition starts in the document the transaction is built on: a
    // position means something only in the document it was read from.
    const before = {
      childCount: 1,
      resolve: () => ({
        depth: 1,
        parent: { type: { name: "heading" } },
        after: () => 15,
      }),
    };
    events.compositionstart({ state: { selection: { from: 5 }, doc: before } });

    // Transaction that splits a heading into heading + paragraph
    const tr = {
      getMeta: () => undefined,
      docChanged: true,
      before,
      doc: {
        childCount: 2, // More children than before → split detected
        content: { size: 30 },
        resolve: (_pos: number) => ({
          nodeAfter: { type: { name: "paragraph" } },
        }),
      },
    };

    expect(filterTransaction(tr)).toBe(false);
  });

  it("allows doc-changing transaction when no heading split detected", () => {
    const { events, filterTransaction } = getPluginSet();
    const before = { childCount: 1 };
    events.compositionstart({ state: { selection: { from: 5 }, doc: before } });

    // Same childCount — no split
    const tr = {
      getMeta: () => undefined,
      docChanged: true,
      before,
      doc: { childCount: 1, content: { size: 10 } },
    };

    expect(filterTransaction(tr)).toBe(true);
  });

  it("allows doc-changing transaction when parent is not a heading", () => {
    const { events, filterTransaction } = getPluginSet();
    const resolveBefore = vi.fn(() => ({
      depth: 1,
      parent: { type: { name: "paragraph" } },
      after: () => 15,
    }));
    const before = { childCount: 1, resolve: resolveBefore };
    events.compositionstart({ state: { selection: { from: 5 }, doc: before } });

    // childCount increased but parent is paragraph, not heading
    const tr = {
      getMeta: () => undefined,
      docChanged: true,
      before,
      doc: {
        childCount: 2,
        content: { size: 30 },
        resolve: () => ({
          nodeAfter: { type: { name: "paragraph" } },
        }),
      },
    };

    expect(filterTransaction(tr)).toBe(true);
    // The verdict came from looking at the block, not from having no anchor.
    expect(resolveBefore).toHaveBeenCalledWith(5);
  });

  it("allows heading split when new sibling is not a paragraph", () => {
    const { events, filterTransaction } = getPluginSet();
    const before = {
      childCount: 1,
      resolve: () => ({
        depth: 1,
        parent: { type: { name: "heading" } },
        after: () => 15,
      }),
    };
    events.compositionstart({ state: { selection: { from: 5 }, doc: before } });
    const resolveAfter = vi.fn(() => ({
      nodeAfter: { type: { name: "blockquote" } },
    }));

    // childCount increased, parent is heading, but sibling is blockquote not paragraph
    const tr = {
      getMeta: () => undefined,
      docChanged: true,
      before,
      doc: {
        childCount: 2,
        content: { size: 30 },
        resolve: resolveAfter,
      },
    };

    expect(filterTransaction(tr)).toBe(true);
    expect(resolveAfter).toHaveBeenCalledWith(15);
  });

  it("allows heading split when afterPos >= doc.content.size", () => {
    const { events, filterTransaction } = getPluginSet();
    const after = vi.fn(() => 30); // equals doc.content.size
    const before = {
      childCount: 1,
      resolve: () => ({
        depth: 1,
        parent: { type: { name: "heading" } },
        after,
      }),
    };
    events.compositionstart({ state: { selection: { from: 5 }, doc: before } });

    // afterPos equals doc size → no room for a paragraph sibling
    const tr = {
      getMeta: () => undefined,
      docChanged: true,
      before,
      doc: {
        childCount: 2,
        content: { size: 30 },
        resolve: () => ({
          nodeAfter: { type: { name: "paragraph" } },
        }),
      },
    };

    expect(filterTransaction(tr)).toBe(true);
    expect(after).toHaveBeenCalled();
  });

  it("catches resolve errors gracefully during heading split check", () => {
    const { events, filterTransaction } = getPluginSet();
    const resolveBefore = vi.fn(() => { throw new Error("stale position"); });
    const before = { childCount: 1, resolve: resolveBefore };
    events.compositionstart({ state: { selection: { from: 5 }, doc: before } });

    const tr = {
      getMeta: () => undefined,
      docChanged: true,
      before,
      doc: {
        childCount: 2,
        content: { size: 30 },
      },
    };

    // Catch block falls through to return true (allow)
    expect(filterTransaction(tr)).toBe(true);
    expect(resolveBefore).toHaveBeenCalledWith(5);
  });

  it("allows a split in a document the composition never reached", () => {
    // The anchor is a position in ONE document. A transaction built on some
    // other document gets no verdict from it, rather than a wrong one.
    const { events, filterTransaction } = getPluginSet();
    events.compositionstart({ state: { selection: { from: 5 }, doc: { childCount: 1 } } });
    const resolveElsewhere = vi.fn(() => ({
      depth: 1,
      parent: { type: { name: "heading" } },
      after: () => 15,
    }));

    const tr = {
      getMeta: () => undefined,
      docChanged: true,
      before: { childCount: 1, resolve: resolveElsewhere },
      doc: {
        childCount: 2,
        content: { size: 30 },
        resolve: () => ({ nodeAfter: { type: { name: "paragraph" } } }),
      },
    };

    expect(filterTransaction(tr)).toBe(true);
    expect(resolveElsewhere).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// appendTransaction — split-block detection during composition
// ---------------------------------------------------------------------------

/**
 * A transaction from document `before` to document `doc` that leaves every
 * position where it was. ProseMirror applies a transaction before it asks
 * plugins to append to it; `applied` plays that step, which is how the guard
 * learns where the composition's anchor is in the document that results.
 */
function stepTo(before: unknown, doc: unknown) {
  return {
    docChanged: true,
    before,
    doc,
    getMeta: () => undefined,
    mapping: { mapResult: (pos: number) => ({ pos, deletedAcross: false }) },
  };
}

describe("compositionGuard appendTransaction — split-block detection", () => {
  function getPluginSet() {
    const plugins = compositionGuardExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "compositionGuard",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const plugin = plugins[0] as unknown as {
      props: {
        handleDOMEvents: Record<string, (view: unknown, event?: unknown) => boolean>;
      };
      spec: {
        state: { apply: (tr: unknown, value: null) => null };
        appendTransaction: (transactions: unknown[], oldState: unknown, newState: unknown) => unknown;
      };
    };
    return {
      events: plugin.props.handleDOMEvents,
      applied: (tr: unknown) => plugin.spec.state.apply(tr, null),
      appendTransaction: plugin.spec.appendTransaction,
    };
  }

  it("detects heading split when doc childCount increases during composition", () => {
    const { events, applied, appendTransaction } = getPluginSet();

    // Set up composition start
    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 1,
            node: (d: number) => ({ type: { name: d === 1 ? "paragraph" : "doc" } }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
      },
      dispatch: vi.fn(),
    };
    events.compositionstart(mockView);

    // appendTransaction sees a doc-changing transaction with new heading split
    const resolveAfter = vi.fn(() => ({
      depth: 1,
      parent: { type: { name: "heading" } },
    }));
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: resolveAfter,
        childCount: 3,
        content: { size: 30 },
      },
    };

    const oldState = {
      doc: { childCount: 2 }, // fewer children → split detected
    };

    // No pendingHeaderCursorFix, so the result is null for the cursor fix part
    const tr = stepTo(mockView.state.doc, newState.doc);
    applied(tr);
    const result = appendTransaction([tr], oldState, newState);
    expect(result).toBeNull();
    // The anchor was looked up in the document the transaction produced.
    expect(resolveAfter).toHaveBeenCalledWith(5);
    // splitDetected flag is set internally — we verify it indirectly via the rAF path later
  });

  it("does not look for a split in a document the composition never reached", () => {
    const { events, appendTransaction } = getPluginSet();
    events.compositionstart({ state: { selection: { from: 5 }, doc: { childCount: 2 } } });
    const resolveElsewhere = vi.fn(() => ({ depth: 1, parent: { type: { name: "heading" } } }));
    const newState = {
      selection: { from: 5 },
      doc: { resolve: resolveElsewhere, childCount: 3, content: { size: 30 } },
    };

    // No transaction leading to this document was applied.
    const result = appendTransaction([{ docChanged: true }], { doc: { childCount: 2 } }, newState);

    expect(result).toBeNull();
    expect(resolveElsewhere).not.toHaveBeenCalled();
  });

  it("appendTransaction catch handles stale position during split detection", () => {
    const { events, applied, appendTransaction } = getPluginSet();

    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 1,
            node: (d: number) => ({ type: { name: d === 1 ? "paragraph" : "doc" } }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
      },
      dispatch: vi.fn(),
    };
    events.compositionstart(mockView);

    // newState.doc.resolve throws
    const resolveAfter = vi.fn(() => { throw new RangeError("stale position"); });
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: resolveAfter,
        childCount: 3,
        content: { size: 30 },
      },
    };

    const oldState = {
      doc: { childCount: 2 },
    };

    // Should not throw — the catch around the lookup swallows the error
    const tr = stepTo(mockView.state.doc, newState.doc);
    applied(tr);
    expect(() => {
      appendTransaction([tr], oldState, newState);
    }).not.toThrow();
    expect(resolveAfter).toHaveBeenCalledWith(5);
  });
});

// ---------------------------------------------------------------------------
// compositionend rAF — snapshotSplit branch (lines 275-292)
// ---------------------------------------------------------------------------

describe("compositionGuard compositionend rAF — snapshotSplit branch", () => {
  function getPluginSet() {
    const plugins = compositionGuardExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "compositionGuard",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never);
    const plugin = plugins[0] as unknown as {
      props: {
        handleDOMEvents: Record<string, (view: unknown, event?: unknown) => boolean>;
      };
      spec: {
        state: { apply: (tr: unknown, value: null) => null };
        appendTransaction: (transactions: unknown[], oldState: unknown, newState: unknown) => unknown;
      };
    };
    return {
      events: plugin.props.handleDOMEvents,
      applied: (tr: unknown) => plugin.spec.state.apply(tr, null),
      appendTransaction: plugin.spec.appendTransaction,
    };
  }

  it("runs split-block fix via rAF when splitDetected is true and fix is available", () => {
    // Real documents throughout: the heading the composition began in is
    // split by the browser, the composed text lands in the new paragraph, and
    // the rAF fallback must move it back — the real fixCompositionSplitBlock.
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        heading: { content: "text*", group: "block", attrs: { level: { default: 1 } } },
        paragraph: { content: "text*", group: "block" },
        text: {},
      },
    });
    // "Title" then the pinyin "nihao"; the composition began after "Title".
    const startDoc = schema.node("doc", null, [schema.node("heading", null, [schema.text("Titlenihao")])]);
    const before = EditorState.create({ schema, doc: startDoc, selection: TextSelection.create(startDoc, 6) });

    // Capture rAF callback to control execution order
    let capturedRafCb: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      capturedRafCb = cb;
      return 0;
    };

    const { events, applied, appendTransaction } = getPluginSet();
    const view = {
      state: before,
      dispatch: vi.fn(),
      domObserver: { flush: vi.fn() },
    };

    events.compositionstart(view);
    events.compositionupdate(view, { data: "nihao" });

    // The browser splits the heading after the pinyin and puts the composed
    // text into a new paragraph, with the cursor there.
    const splitTr = before.tr.split(11, 1, [{ type: schema.nodes.paragraph }]);
    splitTr.insertText("你好", 13);
    splitTr.setSelection(TextSelection.create(splitTr.doc, 15));
    applied(splitTr);
    const after = before.apply(splitTr);
    appendTransaction([splitTr], before, after);
    view.state = after;

    // Now compositionend fires — rAF callback is captured
    events.compositionend(view, { data: "你好" });
    expect(capturedRafCb).not.toBeNull();

    // Run the rAF callback — snapshotSplit is true, so the fix runs
    capturedRafCb!(0);

    // The DOM observer is flushed only on the split-detected branch.
    expect(view.domObserver.flush).toHaveBeenCalled();
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const fixed = (view.dispatch.mock.calls[0][0] as Transaction).doc;
    expect(fixed.childCount).toBe(1);
    expect(fixed.firstChild!.type.name).toBe("heading");
    expect(fixed.firstChild!.textContent).toBe("Title你好");
    expect(mockFlushProseMirrorCompositionQueue).toHaveBeenCalledWith(view);

    // Restore synchronous rAF
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
  it("falls through to scheduleImeCleanup when splitDetected is true but fix returns null", () => {
    mockGetImeCleanupPrefixLength.mockReturnValue(0);

    // Capture rAF callback
    let capturedRafCb: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      capturedRafCb = cb;
      return 0;
    };

    const { events, applied, appendTransaction } = getPluginSet();

    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 1,
            node: (d: number) => ({ type: { name: d === 1 ? "paragraph" : "doc" } }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: {
          delete: vi.fn().mockReturnThis(),
          setMeta: vi.fn().mockReturnThis(),
        },
      },
      dispatch: vi.fn(),
      domObserver: { flush: vi.fn() },
    };

    events.compositionstart(mockView);
    events.compositionupdate(mockView, { data: "nihao" });

    // Trigger split detection
    const oldState = { doc: { childCount: 1 } };
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: () => ({
          depth: 1,
          parent: { type: { name: "heading" } },
        }),
        childCount: 2,
        content: { size: 30 },
      },
    };
    const splitTr = stepTo(mockView.state.doc, newState.doc);
    applied(splitTr);
    appendTransaction([splitTr], oldState, newState);

    events.compositionend(mockView, { data: "你好" });

    expect(capturedRafCb).not.toBeNull();
    capturedRafCb!(0);

    // fix returned null, so it falls through to scheduleImeCleanup
    // which also doesn't dispatch because getImeCleanupPrefixLength returns 0
    expect(mockView.domObserver.flush).toHaveBeenCalled();
    expect(mockView.dispatch).not.toHaveBeenCalled();
    expect(mockFlushProseMirrorCompositionQueue).toHaveBeenCalledWith(mockView);

    // Restore synchronous rAF
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });

  it("skips rAF callback when compositionStartPos changed (stale callback)", () => {

    // Capture rAF callbacks
    const rafCallbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return 0;
    };

    const { events } = getPluginSet();

    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 1,
            node: (d: number) => ({ type: { name: d === 1 ? "paragraph" : "doc" } }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
      },
      dispatch: vi.fn(),
    };

    // First composition session
    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你" });

    // Second composition session starts before first rAF fires
    const mockView2 = {
      state: {
        selection: { from: 10 }, // different position!
        doc: {
          resolve: () => ({
            depth: 1,
            node: (d: number) => ({ type: { name: d === 1 ? "paragraph" : "doc" } }),
            end: () => 25,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
      },
      dispatch: vi.fn(),
    };
    events.compositionstart(mockView2);

    // Run the first rAF callback — compositionStartPos changed, should be no-op
    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);
    rafCallbacks[0](0);

    // dispatch should NOT have been called (stale callback was skipped)
    expect(mockView.dispatch).not.toHaveBeenCalled();

    // Restore synchronous rAF
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
});
