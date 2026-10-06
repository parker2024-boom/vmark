/**
 * Markdown Auto-Pair Delay Chars Tests
 *
 * Tests for delay-based characters (~, *, _), always-double chars (=),
 * backspace pair deletion, and safeDispatch edge cases.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

vi.mock("@/utils/imeGuard", () => ({
  isCodeMirrorComposing: () => false,
  guardCodeMirrorKeyBinding: (binding: unknown) => binding,
}));

import { createMarkdownAutoPairPlugin, markdownPairBackspace } from "../markdownAutoPair";

// The plugin decides single-vs-double on a timer (and inserts the closing
// pair on a zero-delay one); the tests drive that clock instead of sleeping.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function simulateTyping(view: EditorView, char: string): void {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, to: pos, insert: char },
    selection: { anchor: pos + 1 },
    userEvent: "input.type",
  });
}

function createView(doc: string, cursorPos?: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);

  const state = EditorState.create({
    doc,
    selection: cursorPos != null ? { anchor: cursorPos } : undefined,
    extensions: [createMarkdownAutoPairPlugin()],
  });
  return new EditorView({ state, parent });
}

describe("delay-based chars (*, ~, _)", () => {
  let activeView: EditorView | null = null;

  afterEach(() => {
    const parent = activeView?.dom.parentElement;
    activeView?.destroy();
    parent?.remove();
    activeView = null;
  });

  it("single * auto-pairs after delay", async () => {
    activeView = createView("");

    simulateTyping(activeView, "*");
    expect(activeView.state.doc.toString()).toBe("*");

    await vi.advanceTimersByTimeAsync(200);

    expect(activeView.state.doc.toString()).toBe("**");
    expect(activeView.state.selection.main.head).toBe(1);
  });

  it("double ** typed quickly inserts closing **", async () => {
    activeView = createView("");

    simulateTyping(activeView, "*");
    simulateTyping(activeView, "*");

    await vi.advanceTimersByTimeAsync(200);

    // Double typed quickly -> inserts closing pair
    const content = activeView.state.doc.toString();
    expect(content).toBe("****");
  });

  it("single ~ auto-pairs after delay", async () => {
    activeView = createView("");

    simulateTyping(activeView, "~");

    await vi.advanceTimersByTimeAsync(200);

    expect(activeView.state.doc.toString()).toBe("~~");
    expect(activeView.state.selection.main.head).toBe(1);
  });

  it("double ~~ typed quickly inserts closing ~~", async () => {
    activeView = createView("");

    simulateTyping(activeView, "~");
    simulateTyping(activeView, "~");

    await vi.advanceTimersByTimeAsync(200);

    expect(activeView.state.doc.toString()).toBe("~~~~");
  });

  it("single _ auto-pairs after delay", async () => {
    activeView = createView("");

    simulateTyping(activeView, "_");

    await vi.advanceTimersByTimeAsync(200);

    expect(activeView.state.doc.toString()).toBe("__");
    expect(activeView.state.selection.main.head).toBe(1);
  });

  it("does not auto-pair if cursor moved away", async () => {
    activeView = createView("text ", 5);

    // Type * at position 5
    simulateTyping(activeView, "*");

    // Move cursor away before delay
    activeView.dispatch({ selection: { anchor: 0 } });

    await vi.advanceTimersByTimeAsync(200);

    // Should not insert closing pair since cursor moved away from expected position
    // Content should be "text *" (no extra pair)
    expect(activeView.state.doc.toString()).toBe("text *");
  });

  it("different delay char cancels pending", async () => {
    activeView = createView("");

    simulateTyping(activeView, "*");
    // Type _ before delay expires — cancels * pending
    simulateTyping(activeView, "_");

    await vi.advanceTimersByTimeAsync(200);

    // * should not be paired, _ should be paired
    const content = activeView.state.doc.toString();
    expect(content).toBe("*__");
  });
});

describe("always-double chars (=)", () => {
  let activeView: EditorView | null = null;

  afterEach(() => {
    const parent = activeView?.dom.parentElement;
    activeView?.destroy();
    parent?.remove();
    activeView = null;
  });

  it("single = does nothing (waits for second)", async () => {
    activeView = createView("");

    simulateTyping(activeView, "=");

    await vi.advanceTimersByTimeAsync(200);

    // Single = should stay as-is (no pairing for single =)
    expect(activeView.state.doc.toString()).toBe("=");
  });

  it("double == inserts closing ==", async () => {
    activeView = createView("");

    simulateTyping(activeView, "=");
    simulateTyping(activeView, "=");

    await vi.advanceTimersByTimeAsync(200);

    expect(activeView.state.doc.toString()).toBe("====");
  });
});

describe("markdownPairBackspace", () => {
  let activeView: EditorView | null = null;

  afterEach(() => {
    const parent = activeView?.dom.parentElement;
    activeView?.destroy();
    parent?.remove();
    activeView = null;
  });

  function createBackspaceView(doc: string, cursorPos: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const state = EditorState.create({
      doc,
      selection: { anchor: cursorPos },
      extensions: [createMarkdownAutoPairPlugin()],
    });
    return new EditorView({ state, parent });
  }

  it("deletes single pair *|*", () => {
    activeView = createBackspaceView("**", 1);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("deletes single pair ~|~", () => {
    activeView = createBackspaceView("~~", 1);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("deletes single pair _|_", () => {
    activeView = createBackspaceView("__", 1);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("deletes double pair ~~|~~", () => {
    activeView = createBackspaceView("~~~~", 2);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("deletes double pair **|**", () => {
    activeView = createBackspaceView("****", 2);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("deletes double pair ==|==", () => {
    activeView = createBackspaceView("====", 2);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("deletes backtick pair `|`", () => {
    activeView = createBackspaceView("``", 1);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("deletes caret pair ^|^", () => {
    activeView = createBackspaceView("^^", 1);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(true);
    expect(activeView.state.doc.toString()).toBe("");
  });

  it("returns false for non-pair chars", () => {
    activeView = createBackspaceView("ab", 1);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(false);
  });

  it("returns false when selection exists", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc: "**",
      selection: { anchor: 0, head: 2 },
      extensions: [createMarkdownAutoPairPlugin()],
    });
    activeView = new EditorView({ state, parent });

    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(false);
  });

  it("returns false at beginning of document", () => {
    activeView = createBackspaceView("*", 0);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(false);
  });

  it("returns false when chars do not match", () => {
    activeView = createBackspaceView("*_", 1);
    const handled = markdownPairBackspace.run!(activeView);
    expect(handled).toBe(false);
  });
});

describe("plugin destroy", () => {
  it("clears pending timeout on destroy", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const state = EditorState.create({
      doc: "",
      extensions: [createMarkdownAutoPairPlugin()],
    });
    const view = new EditorView({ state, parent });

    simulateTyping(view, "*");

    // Destroy before timeout fires
    view.destroy();
    parent.remove();

    // Should not throw after destroy
    await vi.advanceTimersByTimeAsync(200);
  });
});
