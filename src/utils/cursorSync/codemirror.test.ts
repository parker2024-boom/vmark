// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

import { EditorState } from "@codemirror/state";
import { getCursorInfoFromCodeMirror, restoreCursorInCodeMirror } from "./codemirror";
import type { CursorInfo } from "@/types/cursorSync";

// --- EditorView stand-in: a real editor state, a recorded dispatch ---

interface MockViewOptions {
  content: string;
  cursorPos: number;
}

function buildMockView(opts: MockViewOptions) {
  const dispatched: Array<{ selection: { anchor: number }; scrollIntoView: boolean }> = [];

  return {
    state: EditorState.create({ doc: opts.content, selection: { anchor: opts.cursorPos } }),
    dispatch: vi.fn((args: { selection: { anchor: number }; scrollIntoView?: boolean }) => {
      dispatched.push({ selection: args.selection, scrollIntoView: !!args.scrollIntoView });
    }),
    _dispatched: dispatched,
  };
}

describe("getCursorInfoFromCodeMirror", () => {
  it("extracts cursor info from a simple paragraph", () => {
    const view = buildMockView({ content: "hello world", cursorPos: 3 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.sourceLine).toBe(1);
    expect(info.nodeType).toBe("paragraph");
    expect(info.wordAtCursor).toBe("hello");
    expect(info.offsetInWord).toBe(3);
    expect(info.blockAnchor).toBeUndefined();
  });

  it("detects heading node type", () => {
    const view = buildMockView({ content: "# Heading", cursorPos: 4 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("heading");
    expect(info.sourceLine).toBe(1);
  });

  it("detects list item node type", () => {
    const view = buildMockView({ content: "- list item", cursorPos: 5 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("list_item");
  });

  it("extracts cursor info from second line", () => {
    const content = "first line\nsecond line";
    // Position at start of "second" => offset 11 (after \n)
    const view = buildMockView({ content, cursorPos: 14 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.sourceLine).toBe(2);
  });

  it("detects code block inside fenced block", () => {
    const content = "```js\nconst x = 1;\n```";
    // Position inside code content (line 2, "const x = 1;")
    const view = buildMockView({ content, cursorPos: 6 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("code_block");
    expect(info.blockAnchor).toBeDefined();
    expect(info.blockAnchor!.kind).toBe("code");
  });

  it("provides code block anchor with lineInBlock and columnInLine", () => {
    const content = "```\nline0\nline1\n```";
    // Cursor at "line1" (line index 2), col 3
    // Offset: "```\nline0\n" = 10, then "lin" = 3 more = 13
    const view = buildMockView({ content, cursorPos: 13 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.blockAnchor).toEqual({
      kind: "code",
      lineInBlock: 1,
      columnInLine: 3,
    });
  });

  it("sets columnInLine to 0 when cursor is on the opening fence line (rawLineInBlock < 0)", () => {
    // Cursor ON the ``` opening line → lineIndex === fenceStart → rawLineInBlock = -1
    const content = "```\nline0\n```";
    // Cursor at position 1 (within the opening ```)
    const view = buildMockView({ content, cursorPos: 1 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("code_block");
    expect(info.blockAnchor).toBeDefined();
    expect(info.blockAnchor!.kind).toBe("code");
    // lineInBlock should be clamped to 0
    expect((info.blockAnchor as { lineInBlock: number }).lineInBlock).toBe(0);
    // columnInLine should be 0 (defensive: cursor on fence line)
    expect((info.blockAnchor as { columnInLine: number }).columnInLine).toBe(0);
  });

  it("detects a table cell and anchors the cursor by row, column and offset", () => {
    const content = "| a | b |\n|---|---|\n| 1 | 2 |";
    // Line 3 starts at offset 20; offset 26 is the "2" in the second cell.
    const view = buildMockView({ content, cursorPos: 26 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("table_cell");
    expect(info.blockAnchor).toEqual({ kind: "table", row: 1, col: 1, offsetInCell: 0 });
  });

  it("anchors the header row as row 0", () => {
    const content = "| a | b |\n|---|---|\n| 1 | 2 |";
    const view = buildMockView({ content, cursorPos: 3 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.blockAnchor).toEqual({ kind: "table", row: 0, col: 0, offsetInCell: 1 });
  });

  it("does not report a table anchor for a pipe line with no separator row", () => {
    const view = buildMockView({ content: "a | b", cursorPos: 1 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("paragraph");
    expect(info.blockAnchor).toBeUndefined();
  });

  it("calculates percentInLine for non-empty stripped text", () => {
    const view = buildMockView({ content: "hello world", cursorPos: 5 });
    const info = getCursorInfoFromCodeMirror(view as never);
    // column 5 on "hello world" (11 chars) -> stripped same
    expect(info.percentInLine).toBeCloseTo(5 / 11, 5);
  });

  it("returns percentInLine 0 for empty text", () => {
    const view = buildMockView({ content: "", cursorPos: 0 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.percentInLine).toBe(0);
  });

  it("handles cursor at start of document", () => {
    const view = buildMockView({ content: "hello", cursorPos: 0 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.sourceLine).toBe(1);
    expect(info.percentInLine).toBe(0);
  });

  it("handles cursor at end of document", () => {
    const view = buildMockView({ content: "hello", cursorPos: 5 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.sourceLine).toBe(1);
    expect(info.percentInLine).toBe(1);
  });
});

describe("restoreCursorInCodeMirror", () => {
  it("restores cursor to correct line using sourceLine", () => {
    const content = "line one\nline two\nline three";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 2,
      wordAtCursor: "two",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0.625, // 5/8
      contextBefore: "line ",
      contextAfter: "two",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // Should be on line 2, at the context match position
    const line2 = view.state.doc.line(2);
    expect(selection.anchor).toBeGreaterThanOrEqual(line2.from);
    expect(selection.anchor).toBeLessThanOrEqual(line2.to);
  });

  it("clamps sourceLine to valid range when too high", () => {
    const content = "only line";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 999,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // Should clamp to last line
    expect(selection.anchor).toBeGreaterThanOrEqual(0);
  });

  it("restores cursor in code block using block anchor", () => {
    const content = "```\nline0\nline1\n```";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1, // sourceLine points somewhere near the code block
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "code_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: {
        kind: "code",
        lineInBlock: 1,
        columnInLine: 2,
      },
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // line1 starts at offset 10 ("```\nline0\n" = 10), + col 2 = 12
    expect(selection.anchor).toBe(12);
  });

  it("falls back to generic restore when code block anchor fails", () => {
    const content = "no code here";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "code_block",
      percentInLine: 0.5,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: {
        kind: "code",
        lineInBlock: 0,
        columnInLine: 0,
      },
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("falls back to generic restore when code block anchor target line exceeds doc length", () => {
    // Code block with anchor pointing to a line beyond the document
    const content = "```\nonly\n```";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "code_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: {
        kind: "code",
        lineInBlock: 999, // way beyond document length
        columnInLine: 0,
      },
    };
    restoreCursorInCodeMirror(view as never, info);
    // Should fall back to generic restore and still dispatch
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("falls back to generic restore when the target line has no table cells", () => {
    // A table anchor pointing at a line without any pipe: no cell to land in.
    const content = "plain words here";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "table_cell",
      percentInLine: 0.5,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: {
        kind: "table",
        row: 0,
        col: 99,
        offsetInCell: 0,
      },
    };
    restoreCursorInCodeMirror(view as never, info);
    // Falls back to generic restore: same landing as the anchor-less restore.
    const generic = buildMockView({ content, cursorPos: 0 });
    restoreCursorInCodeMirror(generic as never, { ...info, nodeType: "paragraph", blockAnchor: undefined });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(view.dispatch.mock.calls[0][0].selection).toEqual(generic.dispatch.mock.calls[0][0].selection);
  });

  it("clamps an out-of-range table column to the last cell", () => {
    const content = "| a | b |";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "table_cell",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: { kind: "table", row: 0, col: 99, offsetInCell: 0 },
    };
    restoreCursorInCodeMirror(view as never, info);
    // Last cell's content "b" starts at column 6.
    expect(view.dispatch.mock.calls[0][0].selection.anchor).toBe(6);
  });

  it("restores cursor in table using block anchor", () => {
    const content = "| a | b |\n|---|---|\n| 1 | 2 |";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "table_cell",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: {
        kind: "table",
        row: 0,
        col: 1,
        offsetInCell: 1,
      },
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // Cell 1 content "b" starts at column 6; offsetInCell 1 lands after it.
    expect(selection.anchor).toBe(7);
  });

  it("uses context matching for column within heading", () => {
    const content = "## Hello World";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "World",
      offsetInWord: 0,
      nodeType: "heading",
      percentInLine: 0,
      contextBefore: "Hello ",
      contextAfter: "World",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // "## " (3 chars marker) + "Hello " context match at idx 0 in stripped -> col 6
    // final = 6 + 3 (marker) = 9
    expect(selection.anchor).toBe(9);
  });

  it("uses percentage fallback for column when no match", () => {
    const content = "abcdefghij";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "notfound",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0.5,
      contextBefore: "xx",
      contextAfter: "yy",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    expect(selection.anchor).toBe(5); // round(0.5 * 10)
  });

  it("handles empty document", () => {
    const content = "";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    expect(selection.anchor).toBe(0);
  });

  it("scrolls into view", () => {
    const content = "hello";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch.mock.calls[0][0].scrollIntoView).toBe(true);
  });

  it("uses word match strategy when context pattern is too short", () => {
    const content = "the quick brown fox";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "brown",
      offsetInWord: 2,
      nodeType: "paragraph",
      percentInLine: 0.5,
      contextBefore: "q", // too short for context match (< 4 chars)
      contextAfter: "b",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // "brown" found at index 10, + offsetInWord 2 = 12
    expect(selection.anchor).toBe(12);
  });

  it("detects blockquote node type", () => {
    const view = buildMockView({ content: "> quoted text", cursorPos: 5 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("blockquote");
  });

  it("detects numbered list item", () => {
    const view = buildMockView({ content: "1. numbered item", cursorPos: 5 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("list_item");
  });

  it("detects ordered list with asterisk marker", () => {
    const view = buildMockView({ content: "* star item", cursorPos: 5 });
    const info = getCursorInfoFromCodeMirror(view as never);
    expect(info.nodeType).toBe("list_item");
  });

  it("uses context match for list item lines", () => {
    const content = "- the quick brown fox";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "brown",
      offsetInWord: 0,
      nodeType: "list_item",
      percentInLine: 0.5,
      contextBefore: "the quick ",
      contextAfter: "brown fox",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // "- " is 2 chars marker, stripped text is "the quick brown fox"
    // context match at index 0, contextBefore length 10
    // final = 10 + 2 (marker) = 12
    expect(selection.anchor).toBe(12);
  });

  it("uses context match for blockquote lines", () => {
    const content = "> the quick brown fox";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "brown",
      offsetInWord: 0,
      nodeType: "blockquote",
      percentInLine: 0.5,
      contextBefore: "the quick ",
      contextAfter: "brown fox",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // "> " is 2 chars marker, stripped text is "the quick brown fox"
    // context match "the quick brown fox" at index 0, contextBefore length 10
    // final = 10 + 2 (marker) = 12
    expect(selection.anchor).toBe(12);
  });

  it("restores cursor in nested blockquote + list (> - item)", () => {
    const content = "> - the quick brown fox";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "brown",
      offsetInWord: 0,
      nodeType: "list_item",
      percentInLine: 0.5,
      contextBefore: "the quick ",
      contextAfter: "brown fox",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // "> - " is 4 chars marker (blockquote + list), stripped = "the quick brown fox"
    // context match at 0, contextBefore length 10 -> 10 + 4 = 14
    expect(selection.anchor).toBe(14);
  });

  it("restores cursor in nested blockquote + ordered list (> 1. item)", () => {
    const content = "> 1. the quick brown fox";
    const view = buildMockView({ content, cursorPos: 0 });
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "brown",
      offsetInWord: 0,
      nodeType: "list_item",
      percentInLine: 0.5,
      contextBefore: "the quick ",
      contextAfter: "brown fox",
      blockAnchor: undefined,
    };
    restoreCursorInCodeMirror(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const selection = view.dispatch.mock.calls[0][0].selection;
    // "> " (2) + "1. " (3) = 5 chars marker, stripped = "the quick brown fox"
    // context match at 0, contextBefore length 10 -> 10 + 5 = 15
    expect(selection.anchor).toBe(15);
  });
});
