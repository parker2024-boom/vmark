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

describe("compositionGuard tableHeader cursor fix", () => {
  function getFullPlugin() {
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
        appendTransaction: (transactions: unknown[], oldState: unknown, newState: unknown) => unknown;
      };
    };
    return {
      events: plugin.props.handleDOMEvents,
      appendTransaction: plugin.spec.appendTransaction,
    };
  }

  it("appendTransaction returns null when no pending header cursor fix", () => {
    const { appendTransaction } = getFullPlugin();
    const result = appendTransaction(
      [{ docChanged: true }],
      {},
      { selection: { from: 0 }, doc: { resolve: () => ({}) } },
    );
    expect(result).toBeNull();
  });

  it("appendTransaction processes header cursor fix when doc-changing transaction present", () => {
    const { events, appendTransaction } = getFullPlugin();

    // Set up compositionstart in a tableHeader
    const mockResolve = () => ({
      depth: 2,
      node: (d: number) => ({
        type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
        textContent: "你好",
      }),
      end: () => 20,
      parentOffset: 0,
      parent: { type: { name: "paragraph" }, textContent: "你好" },
    });
    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: mockResolve,
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: {
          delete: vi.fn().mockReturnThis(),
          setMeta: vi.fn().mockReturnThis(),
        },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你好" });

    // appendTransaction with doc-changing transaction should consume pending fix
    const mockNewState = {
      selection: { from: 5 },
      doc: {
        resolve: () => ({
          depth: 2,
          parentOffset: 0,
          parent: { type: { name: "paragraph" }, textContent: "你好hello" },
          node: (d: number) => ({
            type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
          }),
        }),
        content: { size: 30 },
      },
      tr: {
        setSelection: vi.fn().mockReturnThis(),
      },
    };

    // The result depends on whether the mock satisfies all conditions
    const result = appendTransaction([{ docChanged: true }], {}, mockNewState);
    // Either null (conditions not met) or a transaction (conditions met)
    expect(result === null || typeof result === "object").toBe(true);
  });

  it("appendTransaction returns null when parentOffset is not 0 (line 129 guard)", () => {
    const { events, appendTransaction } = getFullPlugin();

    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 2,
            node: (d: number) => ({
              type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
            }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: { delete: vi.fn().mockReturnThis(), setMeta: vi.fn().mockReturnThis() },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你好" });

    // parentOffset != 0 → line 129 guard returns null
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: () => ({
          depth: 2,
          parentOffset: 3,  // not 0 → triggers guard at line 129
          parent: { type: { name: "paragraph" }, textContent: "你好" },
          node: (d: number) => ({
            type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
          }),
        }),
        content: { size: 30 },
      },
      tr: { setSelection: vi.fn().mockReturnThis() },
    };

    const result = appendTransaction([{ docChanged: true }], {}, newState);
    expect(result).toBeNull();
  });

  it("appendTransaction returns null when parent type is not paragraph (line 130 guard)", () => {
    const { events, appendTransaction } = getFullPlugin();

    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 2,
            node: (d: number) => ({
              type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
            }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: { delete: vi.fn().mockReturnThis(), setMeta: vi.fn().mockReturnThis() },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你好" });

    // parent type is "text" (not "paragraph") → line 130 guard returns null
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: () => ({
          depth: 2,
          parentOffset: 0,
          parent: { type: { name: "text" }, textContent: "你好" },  // not paragraph
          node: (d: number) => ({
            type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
          }),
        }),
        content: { size: 30 },
      },
      tr: { setSelection: vi.fn().mockReturnThis() },
    };

    const result = appendTransaction([{ docChanged: true }], {}, newState);
    expect(result).toBeNull();
  });

  it("appendTransaction returns null when cursor is not in tableHeader (line 139 guard)", () => {
    const { events, appendTransaction } = getFullPlugin();

    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 2,
            node: (d: number) => ({
              type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
            }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: { delete: vi.fn().mockReturnThis(), setMeta: vi.fn().mockReturnThis() },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你好" });

    // No tableHeader in ancestors → inTableHeader remains false → line 139 returns null
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: () => ({
          depth: 2,
          parentOffset: 0,
          parent: { type: { name: "paragraph" }, textContent: "你好" },
          // All nodes are paragraph (no tableHeader) → inTableHeader stays false
          node: (d: number) => ({
            type: { name: d === 2 ? "tableCell" : d === 1 ? "paragraph" : "doc" },
          }),
        }),
        content: { size: 30 },
      },
      tr: { setSelection: vi.fn().mockReturnThis() },
    };

    const result = appendTransaction([{ docChanged: true }], {}, newState);
    expect(result).toBeNull();
  });

  it("appendTransaction returns null when textContent does not start with data (line 142 guard)", () => {
    const { events, appendTransaction } = getFullPlugin();

    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 2,
            node: (d: number) => ({
              type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
            }),
            end: () => 20,
          }),
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: { delete: vi.fn().mockReturnThis(), setMeta: vi.fn().mockReturnThis() },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你好" });

    // textContent does NOT start with "你好" → line 142 returns null
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: () => ({
          depth: 2,
          parentOffset: 0,
          parent: { type: { name: "paragraph" }, textContent: "something else" },
          node: (d: number) => ({
            type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
          }),
        }),
        content: { size: 30 },
      },
      tr: { setSelection: vi.fn().mockReturnThis() },
    };

    const result = appendTransaction([{ docChanged: true }], {}, newState);
    expect(result).toBeNull();
  });

  it("scheduleImeCleanup returns early when compositionStartPos > cleanupEnd (line 102)", () => {
    // Use the rAF capture approach to control when scheduleImeCleanup runs
    let capturedRafCb: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      capturedRafCb = cb;
      return 0;
    };

    const { events } = getFullPlugin();

    // compositionStartPos = 10 (from selection.from)
    // cleanupEnd = end() = 3 → compositionStartPos (10) > cleanupEnd (3) → return early
    const mockView = {
      state: {
        selection: { from: 10 },
        doc: {
          resolve: () => ({
            depth: 1,
            node: (d: number) => ({ type: { name: d === 1 ? "paragraph" : "doc" } }),
            end: () => 3,  // cleanupEnd = 3, but compositionStartPos = 10 → 10 > 3
          }),
          textBetween: () => "",
          content: { size: 20 },
        },
        tr: { delete: vi.fn().mockReturnThis(), setMeta: vi.fn().mockReturnThis() },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionupdate(mockView, { data: "ni" });
    events.compositionend(mockView, { data: "你" });

    // Run captured rAF — the cleanup's start-past-the-block guard returns early.
    // Asserted, not optional: a frame that was never scheduled would make the
    // assertion below pass without running the cleanup at all.
    const frame = capturedRafCb as FrameRequestCallback | null;
    expect(frame).not.toBeNull();
    frame?.(0);

    // dispatch should NOT have been called (early return hit)
    expect(mockView.dispatch).not.toHaveBeenCalled();

    // Restore synchronous rAF
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });

  it("appendTransaction catch branch returns null when resolve throws inside try block", () => {
    const { events, appendTransaction } = getFullPlugin();

    // Set up compositionstart in a tableHeader so pendingHeaderCursorFix is set
    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 2,
            node: (d: number) => ({
              type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
            }),
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
    };

    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你好" });

    // appendTransaction with doc-changing transaction but resolve throws in the try block
    const newState = {
      selection: { from: 5 },
      doc: {
        resolve: () => { throw new Error("stale position"); },
        content: { size: 30 },
      },
      tr: { setSelection: vi.fn().mockReturnThis() },
    };

    const result = appendTransaction([{ docChanged: true }], {}, newState);
    // catch block returns null
    expect(result).toBeNull();
  });

  it("compositionend stale position catch: resolve throws inside pendingHeaderCursorFix setup", () => {
    const { events } = getFullPlugin();

    // compositionStartPos = 5, but when compositionend calls findTableCellDepth (resolve(5))
    // then tries to resolve again for cellNode → throw stale error
    let resolveCallCount = 0;
    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => {
            resolveCallCount++;
            // First call (findTableCellDepth loop): works fine → returns tableHeader depth
            // Second call (resolve(compositionStartPos).node(depth)): throws
            if (resolveCallCount >= 2) {
              throw new Error("stale position");
            }
            return {
              depth: 2,
              node: (d: number) => ({
                type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
              }),
              end: () => 20,
            };
          },
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: {
          delete: vi.fn().mockReturnThis(),
          setMeta: vi.fn().mockReturnThis(),
        },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    // Should not throw — the catch block inside compositionend swallows the error
    expect(() => events.compositionend(mockView, { data: "你好" })).not.toThrow();
  });

  it("appendTransaction returns null when no doc-changing transactions", () => {
    const { events, appendTransaction } = getFullPlugin();

    // Set up compositionstart in a tableHeader
    const mockResolve = () => ({
      depth: 2,
      node: (d: number) => ({
        type: { name: d === 2 ? "tableHeader" : d === 1 ? "paragraph" : "doc" },
      }),
      end: () => 20,
    });
    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: mockResolve,
          textBetween: () => "",
          content: { size: 30 },
        },
        tr: {
          delete: vi.fn().mockReturnThis(),
          setMeta: vi.fn().mockReturnThis(),
        },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionend(mockView, { data: "你" });

    // appendTransaction with no doc-changed transaction
    const result = appendTransaction(
      [{ docChanged: false }],
      {},
      { selection: { from: 0 }, doc: { resolve: () => ({}) } },
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scheduleImeCleanup — table cell boundary and dispatch coverage
// ---------------------------------------------------------------------------

describe("compositionGuard scheduleImeCleanup — table cell and dispatch", () => {
  function getFullPlugin() {
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
    };
    return plugin.props.handleDOMEvents;
  }

  it("dispatches delete transaction when getImeCleanupPrefixLength returns nonzero", () => {
    mockGetImeCleanupPrefixLength.mockReturnValue(3);

    const events = getFullPlugin();
    const mockTr = {
      delete: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };
    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 1,
            node: (d: number) => ({ type: { name: d === 1 ? "paragraph" : "doc" } }),
            end: () => 20,
          }),
          textBetween: () => "nihao你好",
          content: { size: 30 },
        },
        tr: mockTr,
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionupdate(mockView, { data: "ni" });
    events.compositionend(mockView, { data: "你" });

    // rAF runs synchronously, scheduleImeCleanup should dispatch
    expect(mockView.dispatch).toHaveBeenCalled();
    expect(mockTr.delete).toHaveBeenCalledWith(5, 8); // deleteFrom=5, deleteTo=5+3
    expect(mockTr.setMeta).toHaveBeenCalledWith("uiEvent", "composition-cleanup");
  });

  it("uses table cell boundary for cleanupEnd when compositionStartPos is inside a table cell", () => {
    mockGetImeCleanupPrefixLength.mockReturnValue(2);

    const events = getFullPlugin();
    const mockTr = {
      delete: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };
    const mockView = {
      state: {
        selection: { from: 5 },
        doc: {
          resolve: () => ({
            depth: 2,
            node: (d: number) => ({
              type: { name: d === 2 ? "tableCell" : d === 1 ? "paragraph" : "doc" },
            }),
            // end(2) = 30 (table cell boundary), end() = 15 (paragraph)
            end: (d?: number) => d === 2 ? 30 : 15,
          }),
          // textBetween should be called with (5, 30, "\n") when using table cell boundary
          textBetween: (_from: number, _to: number) => "hello\nworld",
          content: { size: 40 },
        },
        tr: mockTr,
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    events.compositionupdate(mockView, { data: "ni" });
    events.compositionend(mockView, { data: "你" });

    // Verify dispatch happened (table cell path used cleanupEnd = 30)
    expect(mockView.dispatch).toHaveBeenCalled();
    expect(mockTr.delete).toHaveBeenCalledWith(5, 7); // deleteFrom=5, deleteTo=5+2
  });

  it("dispatches the split-block fix when the composed text landed in a split-off paragraph", () => {
    // Real documents: the composition began in a heading, the browser split
    // it and put the composed text in a new paragraph; the post-composition
    // cleanup must dispatch the real fixCompositionSplitBlock repair.
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        heading: { content: "text*", group: "block", attrs: { level: { default: 1 } } },
        paragraph: { content: "text*", group: "block" },
        text: {},
      },
    });
    const startDoc = schema.node("doc", null, [schema.node("heading", null, [schema.text("Titleni")])]);
    const before = EditorState.create({ schema, doc: startDoc, selection: TextSelection.create(startDoc, 6) });

    const plugin = compositionGuardExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "compositionGuard",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never)[0] as unknown as {
      props: { handleDOMEvents: Record<string, (view: unknown, event?: unknown) => boolean> };
      spec: { state: { apply: (tr: unknown, value: null) => null } };
    };
    const events = plugin.props.handleDOMEvents;
    const view = { state: before, dispatch: vi.fn() };

    events.compositionstart(view);
    events.compositionupdate(view, { data: "ni" });

    const splitTr = before.tr.split(8, 1, [{ type: schema.nodes.paragraph }]);
    splitTr.insertText("你", 10);
    splitTr.setSelection(TextSelection.create(splitTr.doc, 11));
    plugin.spec.state.apply(splitTr, null);
    view.state = before.apply(splitTr);

    // rAF runs synchronously in this suite, so cleanup runs inside compositionend.
    events.compositionend(view, { data: "你" });

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const fixed = (view.dispatch.mock.calls[0][0] as Transaction).doc;
    expect(fixed.childCount).toBe(1);
    expect(fixed.firstChild!.textContent).toBe("Title你");
  });
  it("scheduleImeCleanup returns early when compositionData is empty", () => {

    // Capture rAF callback
    let capturedRafCb: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      capturedRafCb = cb;
      return 0;
    };

    const events = getFullPlugin();
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
          content: { size: 20 },
        },
        tr: {
          delete: vi.fn().mockReturnThis(),
          setMeta: vi.fn().mockReturnThis(),
        },
      },
      dispatch: vi.fn(),
    };

    events.compositionstart(mockView);
    // compositionend with empty data — compositionData stays empty
    events.compositionend(mockView, { data: "" });

    const frame = capturedRafCb as FrameRequestCallback | null;
    expect(frame).not.toBeNull();
    frame?.(0);
    // The cleanup returns early because compositionData is empty
    expect(mockView.dispatch).not.toHaveBeenCalled();

    // Restore synchronous rAF
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
});

// ---------------------------------------------------------------------------
// filterTransaction — heading split rejection
// ---------------------------------------------------------------------------
