// WI-RA10B.3 — the source editor publishes one cursor snapshot per frame, and
// never leaves a snapshot unpublished when the editor hides or goes away.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CursorInfo } from "@/types/cursorSync";
import { sourceFenceIndex } from "@/utils/cursorSync/fenceIndex";
import { createSourceCursorTracker, sourceCursorExtension } from "./sourceCursorTracker";

const FRAME_MS = 16;

function mount(doc: string) {
  const setCursorInfo = vi.fn<(info: CursorInfo) => void>();
  const setSelectedText = vi.fn<(text: string) => void>();
  const tracker = createSourceCursorTracker({ setCursorInfo, setSelectedText });
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) tracker.track(update);
        }),
        sourceCursorExtension,
      ],
    }),
  });
  return { view, tracker, setCursorInfo, setSelectedText };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSourceCursorTracker", () => {
  it("publishes nothing until the frame, then one snapshot of the latest position", () => {
    const { view, setCursorInfo } = mount("first\nsecond\nthird");

    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ selection: { anchor: 8 } });
    view.dispatch({ selection: { anchor: 15 } });
    expect(setCursorInfo).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FRAME_MS);
    expect(setCursorInfo).toHaveBeenCalledTimes(1);
    expect(setCursorInfo.mock.calls[0][0].sourceLine).toBe(3);
    view.destroy();
  });

  it("publishes a snapshot for a keystroke, reading the document as typed", () => {
    const { view, setCursorInfo } = mount("```\ncode");

    view.dispatch({ changes: { from: 8, insert: "\nmore" }, selection: { anchor: 13 } });
    vi.advanceTimersByTime(FRAME_MS);

    expect(setCursorInfo).toHaveBeenCalledTimes(1);
    expect(setCursorInfo.mock.calls[0][0]).toMatchObject({
      sourceLine: 3,
      nodeType: "code_block",
      blockAnchor: { kind: "code", lineInBlock: 1, columnInLine: 4 },
    });
    view.destroy();
  });

  it("schedules a new frame for updates that arrive after one fired", () => {
    const { view, setCursorInfo } = mount("first\nsecond");

    view.dispatch({ selection: { anchor: 1 } });
    vi.advanceTimersByTime(FRAME_MS);
    view.dispatch({ selection: { anchor: 7 } });
    vi.advanceTimersByTime(FRAME_MS);

    expect(setCursorInfo.mock.calls.map(([info]) => info.sourceLine)).toEqual([1, 2]);
    view.destroy();
  });

  it("flush publishes the pending snapshot at once, and the frame does not publish it again", () => {
    const { view, tracker, setCursorInfo } = mount("first\nsecond");

    view.dispatch({ selection: { anchor: 7 } });
    tracker.flush();
    expect(setCursorInfo).toHaveBeenCalledTimes(1);
    expect(setCursorInfo.mock.calls[0][0].sourceLine).toBe(2);

    vi.advanceTimersByTime(FRAME_MS);
    expect(setCursorInfo).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("flush with nothing pending publishes nothing", () => {
    const { view, tracker, setCursorInfo } = mount("text");
    tracker.flush();
    vi.advanceTimersByTime(FRAME_MS);
    expect(setCursorInfo).not.toHaveBeenCalled();
    view.destroy();
  });

  it("publishes selected text immediately, every range joined by a newline", () => {
    const { view, setSelectedText } = mount("alpha beta gamma");

    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(setSelectedText).toHaveBeenLastCalledWith("alpha");

    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(11, 16)]),
    });
    expect(setSelectedText).toHaveBeenLastCalledWith("alpha\ngamma");

    view.dispatch({ selection: { anchor: 3 } });
    expect(setSelectedText).toHaveBeenLastCalledWith("");
    view.destroy();
  });

  it("installs the fence index the snapshot reads", () => {
    const { view } = mount("```\ncode");
    expect(view.state.field(sourceFenceIndex, false)).toBeDefined();
    view.destroy();
  });
});
