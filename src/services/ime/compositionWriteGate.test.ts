// @vitest-environment node
// WI-RA10A.2 — a write that is not the user's typing waits for an IME
// composition to end and be cleaned up, or is told one is in progress.
/**
 * The first half pins the gate against a stand-in view and the real
 * composition bookkeeping in `utils/imeGuard`. The second half runs it with
 * the real composition guard plugin, where the point is the ORDER: the
 * deferred write must land after the guard has removed leftover preedit text,
 * so it changes the document the user ended up with.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Plugin, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  flushProseMirrorCompositionQueue,
  IME_GRACE_PERIOD_MS,
  markProseMirrorCompositionEnd,
} from "@/utils/imeGuard";
import { compositionGuardExtension } from "@/plugins/compositionGuard/tiptap";
import { isCompositionInProgress, writeWhenCompositionSettles } from "./compositionWriteGate";

interface StubView {
  composing: boolean;
  isDestroyed: boolean;
}

function stubView(overrides: Partial<StubView> = {}): { stub: StubView; view: EditorView } {
  const stub: StubView = { composing: false, isDestroyed: false, ...overrides };
  return { stub, view: stub as unknown as EditorView };
}

/** What the composition guard does when a composition ends. */
function endComposition(stub: StubView, view: EditorView): void {
  stub.composing = false;
  markProseMirrorCompositionEnd(view);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  // A page's clock has been running for a while by the time anyone types.
  vi.advanceTimersByTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isCompositionInProgress", () => {
  it("is false for no view at all", () => {
    expect(isCompositionInProgress(null)).toBe(false);
    expect(isCompositionInProgress(undefined)).toBe(false);
  });

  it("is false for a view nobody is composing in", () => {
    expect(isCompositionInProgress(stubView().view)).toBe(false);
  });

  it("is true while composing", () => {
    expect(isCompositionInProgress(stubView({ composing: true }).view)).toBe(true);
  });

  it("stays true through the grace period after the composition ends, then clears", () => {
    const { stub, view } = stubView({ composing: true });
    endComposition(stub, view);

    expect(isCompositionInProgress(view)).toBe(true);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS - 1);
    expect(isCompositionInProgress(view)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isCompositionInProgress(view)).toBe(false);
  });
});

describe("writeWhenCompositionSettles", () => {
  it("runs the write at once when nobody is composing", () => {
    const write = vi.fn();

    expect(writeWhenCompositionSettles(stubView().view, write)).toBe("applied");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("holds the write while composing, however long that lasts", () => {
    const { view } = stubView({ composing: true });
    const write = vi.fn();

    expect(writeWhenCompositionSettles(view, write)).toBe("deferred");
    vi.advanceTimersByTime(60_000);

    expect(write).not.toHaveBeenCalled();
    // Nothing polls: the wait is on the composition guard's flush.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs it once, after the composition has ended and the grace period has passed", () => {
    const { stub, view } = stubView({ composing: true });
    const write = vi.fn();
    writeWhenCompositionSettles(view, write);

    endComposition(stub, view);
    flushProseMirrorCompositionQueue(view);
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("holds a write that arrives in the grace period, with no composition in progress", () => {
    const { stub, view } = stubView({ composing: true });
    endComposition(stub, view);
    const write = vi.fn();

    expect(writeWhenCompositionSettles(view, write)).toBe("deferred");
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("goes on waiting when a new composition starts before it could run", () => {
    const { stub, view } = stubView({ composing: true });
    const write = vi.fn();
    writeWhenCompositionSettles(view, write);
    endComposition(stub, view);
    flushProseMirrorCompositionQueue(view);

    // The next character's composition begins inside the grace period.
    stub.composing = true;
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);
    expect(write).not.toHaveBeenCalled();

    endComposition(stub, view);
    flushProseMirrorCompositionQueue(view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps deferred writes in the order they were submitted", () => {
    const { stub, view } = stubView({ composing: true });
    const order: string[] = [];
    writeWhenCompositionSettles(view, () => order.push("first"));
    writeWhenCompositionSettles(view, () => order.push("second"));
    endComposition(stub, view);
    flushProseMirrorCompositionQueue(view);
    writeWhenCompositionSettles(view, () => order.push("third"));

    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("does not let a late write overtake ones still waiting", () => {
    // The flush comes late in the grace period, so the waiting writes are due
    // after it has expired. One submitted in between finds no composition in
    // progress — and must still queue behind them.
    const { stub, view } = stubView({ composing: true });
    const order: string[] = [];
    writeWhenCompositionSettles(view, () => order.push("waiting"));
    endComposition(stub, view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS - 10);
    flushProseMirrorCompositionQueue(view);
    vi.advanceTimersByTime(20);
    expect(isCompositionInProgress(view)).toBe(false);

    expect(writeWhenCompositionSettles(view, () => order.push("late"))).toBe("deferred");
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(order).toEqual(["waiting", "late"]);
  });

  it("applies directly again once the line has cleared", () => {
    const { stub, view } = stubView({ composing: true });
    writeWhenCompositionSettles(view, vi.fn());
    endComposition(stub, view);
    flushProseMirrorCompositionQueue(view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    const write = vi.fn();
    expect(writeWhenCompositionSettles(view, write)).toBe("applied");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("drops the writes of a view that is destroyed while they wait", () => {
    const { stub, view } = stubView({ composing: true });
    const write = vi.fn();
    writeWhenCompositionSettles(view, write);

    stub.isDestroyed = true;
    endComposition(stub, view);
    flushProseMirrorCompositionQueue(view);
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(write).not.toHaveBeenCalled();
  });

  it("keeps the writes of different views apart", () => {
    const composing = stubView({ composing: true });
    const idle = stubView();
    const held = vi.fn();
    const free = vi.fn();

    writeWhenCompositionSettles(composing.view, held);
    expect(writeWhenCompositionSettles(idle.view, free)).toBe("applied");

    expect(free).toHaveBeenCalledTimes(1);
    expect(held).not.toHaveBeenCalled();
  });

  it("runs the writes behind one that throws, and still reports the failure", () => {
    const { stub, view } = stubView({ composing: true });
    const after = vi.fn();
    writeWhenCompositionSettles(view, () => {
      throw new Error("stale range");
    });
    writeWhenCompositionSettles(view, after);
    endComposition(stub, view);
    flushProseMirrorCompositionQueue(view);

    expect(() => vi.advanceTimersByTime(IME_GRACE_PERIOD_MS)).toThrow("stale range");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("lets an immediate write's own failure reach the caller", () => {
    expect(() =>
      writeWhenCompositionSettles(stubView().view, () => {
        throw new Error("bad write");
      }),
    ).toThrow("bad write");
  });
});

describe("with the composition guard", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
      text: { inline: true },
    },
  });
  const paragraph = (text = "") =>
    schema.node("paragraph", null, text ? [schema.text(text)] : []);
  const docOf = (...blocks: PMNode[]) => schema.node("doc", null, blocks);

  let frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    frames = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    };
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
  });

  function mount(document: PMNode, cursor: number) {
    const plugins = compositionGuardExtension.config.addProseMirrorPlugins!.call({
      editor: {},
      name: "compositionGuard",
      options: {},
      storage: {},
      type: undefined,
      parent: undefined,
    } as never) as Plugin[];
    const base = EditorState.create({ schema, doc: document, plugins });
    const holder = {
      state: base.apply(base.tr.setSelection(TextSelection.create(base.doc, cursor))),
      composing: false,
      isDestroyed: false,
      dispatch(tr: Transaction) {
        holder.state = holder.state.apply(tr);
      },
    };
    const view = holder as unknown as EditorView;
    const events = (
      plugins[0]!.props as {
        handleDOMEvents: Record<string, (view: EditorView, event?: unknown) => boolean>;
      }
    ).handleDOMEvents;
    return {
      holder,
      view,
      events,
      text: () => holder.state.doc.textBetween(0, holder.state.doc.content.size, "|"),
      runFrames: () => {
        const due = frames;
        frames = [];
        for (const frame of due) frame(0);
      },
    };
  }

  it("applies a deferred write after the guard's cleanup, to the cleaned document", () => {
    const editor = mount(docOf(paragraph("X")), 2);
    editor.events.compositionstart!(editor.view);
    editor.holder.composing = true;
    editor.view.dispatch(editor.holder.state.tr.insertText("nihao").setMeta("composition", 1));
    editor.events.compositionupdate!(editor.view, { data: "nihao" });

    // An AI client's edit arrives mid-composition: prepend to the paragraph.
    const outcome = writeWhenCompositionSettles(editor.view, () => {
      const { state } = editor.view;
      editor.view.dispatch(state.tr.insertText("hello world ", 1).setMeta("addToHistory", true));
    });
    expect(outcome).toBe("deferred");
    expect(editor.text()).toBe("Xnihao");

    // WebKit commits the candidate but leaves the preedit text behind.
    editor.view.dispatch(editor.holder.state.tr.insertText("你好").setMeta("composition", 1));
    editor.holder.composing = false;
    editor.events.compositionend!(editor.view, { data: "你好" });
    editor.runFrames();
    // The guard has cleaned up; the write is still held for the grace period.
    expect(editor.text()).toBe("X你好");

    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);
    expect(editor.text()).toBe("hello world X你好");
  });

  it("releases a deferred write when the editor loses focus mid-composition", () => {
    const editor = mount(docOf(paragraph("X")), 2);
    editor.events.compositionstart!(editor.view);
    editor.holder.composing = true;
    const write = vi.fn();
    writeWhenCompositionSettles(editor.view, write);

    editor.holder.composing = false;
    editor.events.blur!(editor.view);
    editor.runFrames();
    vi.advanceTimersByTime(IME_GRACE_PERIOD_MS);

    expect(write).toHaveBeenCalledTimes(1);
  });
});
