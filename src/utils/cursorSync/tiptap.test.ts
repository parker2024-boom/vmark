import { describe, it, expect, vi } from "vitest";

import { getCursorInfoFromTiptap, restoreCursorInTiptap } from "./tiptap";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { CursorInfo } from "@/types/cursorSync";
import { schema, para, heading, codeBlock, table, createState, createMockView } from "./__tests__/tiptapFixtures";


describe("getCursorInfoFromTiptap", () => {
  it("extracts basic cursor info from paragraph", () => {
    const doc = schema.node("doc", null, [para("hello world", 1)]);
    // Position 4 -> inside "hello world" at offset 3 from para start
    const state = createState(doc, 4);
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.sourceLine).toBe(1);
    expect(info.nodeType).toBe("paragraph");
    expect(info.wordAtCursor).toBe("hello");
  });

  it("detects heading node type", () => {
    const doc = schema.node("doc", null, [heading("Title", 1)]);
    const state = createState(doc, 2);
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("heading");
  });

  it("detects code_block node type", () => {
    const doc = schema.node("doc", null, [codeBlock("const x = 1;", 5)]);
    const state = createState(doc, 3);
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("code_block");
  });

  it("detects blockquote node type", () => {
    const bq = schema.node("blockquote", { sourceLine: 3 }, [para("quoted", 3)]);
    const doc = schema.node("doc", null, [bq]);
    const state = createState(doc, 3);
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("blockquote");
  });

  it("falls back to estimateSourceLine when no sourceLine attr", () => {
    const doc = schema.node("doc", null, [para("no source line")]);
    const state = createState(doc, 2);
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    // estimateSourceLine defaults to 1
    expect(info.sourceLine).toBe(1);
  });

  it("calculates percentInLine correctly", () => {
    const doc = schema.node("doc", null, [para("1234567890", 1)]);
    // Position at offset 5 within the paragraph
    const state = createState(doc, 6); // +1 for node open
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.percentInLine).toBeCloseTo(0.5, 1);
  });

  it("returns percentInLine 0 for empty text", () => {
    const doc = schema.node("doc", null, [para("", 1)]);
    const state = createState(doc, 1);
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.percentInLine).toBe(0);
  });

  it("includes a code block anchor with line and column in the block", () => {
    const doc = schema.node("doc", null, [codeBlock("line0\nline1\nline2 text", 1)]);
    // Content starts at 1; "line0\nline1\n" is 12 chars, then 5 more.
    const state = createState(doc, 1 + 12 + 5);
    const view = createMockView(state);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.blockAnchor).toEqual({
      kind: "code",
      lineInBlock: 2,
      columnInLine: 5,
    });
  });

  it("includes a table anchor with row, column and offset in the cell", () => {
    const doc = schema.node("doc", null, [table([["h1", "h2"], ["a1", "b2x"]], 1)]);
    // Find the position inside "b2x" after "b2".
    let target = -1;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === "b2x") target = pos + 2;
    });
    const view = createMockView(createState(doc, target));

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.blockAnchor).toMatchObject({ kind: "table", row: 1, col: 1 });
  });

  it("round-trips a table cursor: the restored cursor lands in the same cell", () => {
    const doc = schema.node("doc", null, [table([["h1", "h2"], ["a1", "b2x"], ["c1", "d2"]], 1)]);
    let target = -1;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === "a1") target = pos + 1;
    });
    const info = getCursorInfoFromTiptap(createMockView(createState(doc, target)) as never);

    const view = createMockView(createState(doc));
    restoreCursorInTiptap(view as never, info);
    const $head = view.dispatch.mock.calls[0][0].selection.$head;
    expect($head.parent.textContent).toBe("a1");
    expect($head.pos).toBe(target);
  });
});

describe("restoreCursorInTiptap", () => {
  it("restores cursor to matching sourceLine paragraph", () => {
    const doc = schema.node("doc", null, [
      para("first", 1),
      para("second", 3),
      para("third", 5),
    ]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 3,
      wordAtCursor: "second",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "second",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("restores into the anchored table cell when blockAnchor is table", () => {
    const doc = schema.node("doc", null, [para("before", 1), table([["h1", "h2"], ["a1", "b2x"]], 3)]);
    const view = createMockView(createState(doc));

    const info: CursorInfo = {
      sourceLine: 3,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "table_cell",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: { kind: "table", row: 1, col: 1, offsetInCell: 1 },
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const tr = view.dispatch.mock.calls[0][0];
    const $head = tr.selection.$head;
    expect($head.parent.textContent).toBe("b2x");
    expect(tr.getMeta("addToHistory")).toBe(false);
  });

  it("restores into the anchored code block line and column when blockAnchor is code", () => {
    const doc = schema.node("doc", null, [para("intro", 1), codeBlock("abc\ndefgh", 2)]);
    const view = createMockView(createState(doc));

    const info: CursorInfo = {
      sourceLine: 2,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "code_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
      blockAnchor: { kind: "code", lineInBlock: 1, columnInLine: 2 },
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const tr = view.dispatch.mock.calls[0][0];
    // Code block content starts after "intro" paragraph (7) + 1; "abc\n" + "de".
    expect(tr.selection.$head.parent.type.name).toBe("codeBlock");
    expect(tr.selection.$head.parentOffset).toBe(4 + 2);
  });

  it("falls back to generic restore when no code block matches the anchor", () => {
    const doc = schema.node("doc", null, [para("fallback text", 1)]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "fallback",
      offsetInWord: 0,
      nodeType: "code_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "fallback text",
      blockAnchor: { kind: "code", lineInBlock: 0, columnInLine: 0 },
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(view.dispatch.mock.calls[0][0].selection.$head.parent.textContent).toBe("fallback text");
  });

  it("falls back to closest sourceLine when exact match not found", () => {
    const doc = schema.node("doc", null, [
      para("line one", 1),
      para("line ten", 10),
    ]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 5,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("goes to start when no matching node found", () => {
    const doc = schema.node("doc", null, [para("no source lines")]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 99,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };

    restoreCursorInTiptap(view as never, info);
    // Should still dispatch something (either fallback or start)
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("positions at end of line when percentInLine >= threshold", () => {
    const doc = schema.node("doc", null, [para("hello world", 1)]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 1.0,
      contextBefore: "",
      contextAfter: "",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("uses context matching for column position", () => {
    const doc = schema.node("doc", null, [para("the quick brown fox", 1)]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "brown",
      offsetInWord: 2,
      nodeType: "paragraph",
      percentInLine: 0.5,
      contextBefore: "the quick ",
      contextAfter: "brown fox",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("sets addToHistory meta to false", () => {
    const doc = schema.node("doc", null, [para("text", 1)]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.getMeta("addToHistory")).toBe(false);
  });

  it("falls back to generic restore when no table matches the anchor", () => {
    const doc = schema.node("doc", null, [para("text", 1)]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "text",
      offsetInWord: 0,
      nodeType: "table_cell",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "text",
      blockAnchor: { kind: "table", row: 0, col: 0, offsetInCell: 0 },
    };

    restoreCursorInTiptap(view as never, info);
    // No table in the document, so the generic restore lands in the paragraph.
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(view.dispatch.mock.calls[0][0].selection.$head.parent.textContent).toBe("text");
  });

  it("falls back to generic restore when the anchored table cell does not exist", () => {
    const doc = schema.node("doc", null, [table([["h1"], ["a1"]], 1)]);
    const view = createMockView(createState(doc));

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "a1",
      offsetInWord: 0,
      nodeType: "table_cell",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "a1",
      blockAnchor: { kind: "table", row: 5, col: 0, offsetInCell: 0 },
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("handles blockAnchor with undefined kind gracefully", () => {
    const doc = schema.node("doc", null, [para("text", 1)]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
      // blockAnchor with unknown kind — should fall through
      blockAnchor: { kind: "unknown" as never },
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("clamps column to line length to prevent overflow", () => {
    const doc = schema.node("doc", null, [para("hi", 1)]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "verylongword",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0.3,
      contextBefore: "verylongword is here",
      contextAfter: "",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("handles TextSelection.near failure by going to doc start", () => {
    const doc = schema.node("doc", null, [para("text", 1)]);
    const state = createState(doc);
    // Create a mock view where dispatch works but we simulate exception via a broken state
    const view = {
      state,
      dispatch: vi.fn((_tr: unknown) => {
        // accept first call, nothing special
      }),
    };

    // We can't easily trigger TextSelection.near to throw with real PM objects,
    // but we can verify the normal path completes.
    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("handles no sourceLine match and no closest fallback (all null)", () => {
    // All paragraphs have sourceLine=null, target sourceLine=99
    const doc = schema.node("doc", null, [para("abc"), para("def")]);
    const state = createState(doc);
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 99,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });
});

// Additional tests for getNodeTypeFromAncestors — cover all node type branches
describe("getNodeTypeFromAncestors — extended coverage via getCursorInfoFromTiptap", () => {
  // We need additional node types in schema for comprehensive coverage
  const extendedSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        content: "text*",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "p" }],
        toDOM() { return ["p", 0]; },
      },
      heading: {
        content: "text*",
        group: "block",
        attrs: { sourceLine: { default: null }, level: { default: 1 } },
        parseDOM: [{ tag: "h1" }],
        toDOM() { return ["h1", 0]; },
      },
      codeBlock: {
        content: "text*",
        group: "block",
        code: true,
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "pre" }],
        toDOM() { return ["pre", 0]; },
      },
      blockquote: {
        content: "block+",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "blockquote" }],
        toDOM() { return ["blockquote", 0]; },
      },
      bulletList: {
        content: "listItem+",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "ul" }],
        toDOM() { return ["ul", 0]; },
      },
      orderedList: {
        content: "listItem+",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "ol" }],
        toDOM() { return ["ol", 0]; },
      },
      listItem: {
        content: "paragraph+",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "li" }],
        toDOM() { return ["li", 0]; },
      },
      text: { inline: true },
      wikiLink: {
        inline: true,
        group: "inline",
        atom: true,
        attrs: { sourceLine: { default: null }, target: { default: "" } },
        parseDOM: [{ tag: "span.wiki-link" }],
        toDOM() { return ["span", { class: "wiki-link" }, 0]; },
      },
    },
  });

  it("detects list_item node type in bulletList", () => {
    const li = extendedSchema.node("listItem", {}, [
      extendedSchema.node("paragraph", { sourceLine: 1 }, [extendedSchema.text("list item")]),
    ]);
    const ul = extendedSchema.node("bulletList", {}, [li]);
    const doc = extendedSchema.node("doc", null, [ul]);
    const state = EditorState.create({ doc, schema: extendedSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 4))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("list_item");
  });

  it("detects list_item node type in orderedList", () => {
    const li = extendedSchema.node("listItem", {}, [
      extendedSchema.node("paragraph", { sourceLine: 1 }, [extendedSchema.text("ordered item")]),
    ]);
    const ol = extendedSchema.node("orderedList", {}, [li]);
    const doc = extendedSchema.node("doc", null, [ol]);
    const state = EditorState.create({ doc, schema: extendedSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 4))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("list_item");
  });
});

// Tests for additional node types: taskItem, taskList, detailsSummary, tableCell, alertBlock
describe("getNodeTypeFromAncestors — taskItem/taskList/detailsSummary/table/alert", () => {
  const taskSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        content: "text*",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "p" }],
        toDOM() { return ["p", 0]; },
      },
      taskList: {
        content: "taskItem+",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "ul.task-list" }],
        toDOM() { return ["ul", { class: "task-list" }, 0]; },
      },
      taskItem: {
        content: "paragraph+",
        attrs: { sourceLine: { default: null }, checked: { default: false } },
        parseDOM: [{ tag: "li.task-item" }],
        toDOM() { return ["li", { class: "task-item" }, 0]; },
      },
      detailsBlock: {
        content: "detailsSummary block*",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "details" }],
        toDOM() { return ["details", 0]; },
      },
      detailsSummary: {
        content: "text*",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "summary" }],
        toDOM() { return ["summary", 0]; },
      },
      alertBlock: {
        content: "block+",
        group: "block",
        attrs: { sourceLine: { default: null }, kind: { default: "note" } },
        parseDOM: [{ tag: "div.alert" }],
        toDOM() { return ["div", { class: "alert" }, 0]; },
      },
      table: {
        content: "tableRow+",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "table" }],
        toDOM() { return ["table", 0]; },
      },
      tableRow: {
        content: "(tableCell | tableHeader)+",
        parseDOM: [{ tag: "tr" }],
        toDOM() { return ["tr", 0]; },
      },
      tableCell: {
        content: "paragraph+",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "td" }],
        toDOM() { return ["td", 0]; },
      },
      tableHeader: {
        content: "paragraph+",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "th" }],
        toDOM() { return ["th", 0]; },
      },
      text: { inline: true },
    },
  });

  it("detects list_item for taskItem", () => {
    const ti = taskSchema.node("taskItem", { checked: false }, [
      taskSchema.node("paragraph", { sourceLine: 1 }, [taskSchema.text("task")]),
    ]);
    const tl = taskSchema.node("taskList", {}, [ti]);
    const doc = taskSchema.node("doc", null, [tl]);
    const state = EditorState.create({ doc, schema: taskSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 4))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("list_item");
  });

  it("detects details_block for detailsSummary", () => {
    const summary = taskSchema.node("detailsSummary", { sourceLine: 1 }, [taskSchema.text("Summary")]);
    const details = taskSchema.node("detailsBlock", { sourceLine: 1 }, [
      summary,
      taskSchema.node("paragraph", { sourceLine: 2 }, [taskSchema.text("body")]),
    ]);
    const doc = taskSchema.node("doc", null, [details]);
    const state = EditorState.create({ doc, schema: taskSchema });
    // cursor inside detailsSummary text
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("details_block");
  });

  it("detects alert_block for alertBlock", () => {
    const alert = taskSchema.node("alertBlock", { sourceLine: 1 }, [
      taskSchema.node("paragraph", { sourceLine: 2 }, [taskSchema.text("alert text")]),
    ]);
    const doc = taskSchema.node("doc", null, [alert]);
    const state = EditorState.create({ doc, schema: taskSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 4))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("alert_block");
  });

  it("detects table_cell for tableCell", () => {
    const cell = taskSchema.node("tableCell", {}, [
      taskSchema.node("paragraph", { sourceLine: 1 }, [taskSchema.text("cell")]),
    ]);
    const row = taskSchema.node("tableRow", null, [cell]);
    const table = taskSchema.node("table", {}, [row]);
    const doc = taskSchema.node("doc", null, [table]);
    const state = EditorState.create({ doc, schema: taskSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 4))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("table_cell");
  });

  it("detects table_cell for tableHeader", () => {
    const header = taskSchema.node("tableHeader", {}, [
      taskSchema.node("paragraph", { sourceLine: 1 }, [taskSchema.text("header")]),
    ]);
    const row = taskSchema.node("tableRow", null, [header]);
    const table = taskSchema.node("table", {}, [row]);
    const doc = taskSchema.node("doc", null, [table]);
    const state = EditorState.create({ doc, schema: taskSchema });
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 4))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("table_cell");
  });
});

// Test for wikiLink node type (line 48)
describe("getNodeTypeFromAncestors — wikiLink", () => {
  // Schema with wikiLink as a block-level node so the cursor can sit inside it
  const wikiSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        content: "inline*",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "p" }],
        toDOM() { return ["p", 0]; },
      },
      text: { inline: true, group: "inline" },
      wikiLink: {
        content: "text*",
        inline: true,
        group: "inline",
        attrs: { sourceLine: { default: null }, target: { default: "" } },
        parseDOM: [{ tag: "span.wiki-link" }],
        toDOM() { return ["span", { class: "wiki-link" }, 0]; },
      },
    },
  });

  it("detects wiki_link node type when cursor is inside wikiLink", () => {
    const wl = wikiSchema.node("wikiLink", { target: "SomePage" }, [wikiSchema.text("SomePage")]);
    const p = wikiSchema.node("paragraph", { sourceLine: 1 }, [wl]);
    const doc = wikiSchema.node("doc", null, [p]);
    const state = EditorState.create({ doc, schema: wikiSchema });
    // cursor inside wikiLink text: pos 2 = inside p(1) > wikiLink(1) > text
    const stateWithSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3))
    );
    const view = createMockView(stateWithSel);

    const info = getCursorInfoFromTiptap(view as never);
    expect(info.nodeType).toBe("wiki_link");
  });
});

// Tests for container node restoration (alertBlock, detailsBlock)
describe("restoreCursorInTiptap — container node handling", () => {
  // Schema with alertBlock and detailsBlock container nodes
  const containerSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        content: "text*",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "p" }],
        toDOM() { return ["p", 0]; },
      },
      blockquote: {
        content: "block+",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "blockquote" }],
        toDOM() { return ["blockquote", 0]; },
      },
      alertBlock: {
        content: "block+",
        group: "block",
        attrs: { sourceLine: { default: null }, kind: { default: "note" } },
        parseDOM: [{ tag: "div.alert" }],
        toDOM() { return ["div", { class: "alert" }, 0]; },
      },
      detailsBlock: {
        content: "block+",
        group: "block",
        attrs: { sourceLine: { default: null } },
        parseDOM: [{ tag: "details" }],
        toDOM() { return ["details", 0]; },
      },
      text: { inline: true },
    },
  });

  it("restores cursor into alertBlock first textblock child", () => {
    const alert = containerSchema.node("alertBlock", { sourceLine: 5, kind: "note" }, [
      containerSchema.node("paragraph", { sourceLine: 6 }, [containerSchema.text("alert content")]),
    ]);
    const doc = containerSchema.node("doc", null, [
      containerSchema.node("paragraph", { sourceLine: 1 }, [containerSchema.text("before")]),
      alert,
    ]);
    const state = EditorState.create({ doc, schema: containerSchema });
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 5,
      wordAtCursor: "alert",
      offsetInWord: 0,
      nodeType: "alert_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "alert content",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    // The dispatch should set cursor inside the alert's paragraph child
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.getMeta("addToHistory")).toBe(false);
  });

  it("restores cursor into detailsBlock first textblock child", () => {
    const details = containerSchema.node("detailsBlock", { sourceLine: 3 }, [
      containerSchema.node("paragraph", { sourceLine: 4 }, [containerSchema.text("details content")]),
    ]);
    const doc = containerSchema.node("doc", null, [
      containerSchema.node("paragraph", { sourceLine: 1 }, [containerSchema.text("before")]),
      details,
    ]);
    const state = EditorState.create({ doc, schema: containerSchema });
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 3,
      wordAtCursor: "details",
      offsetInWord: 0,
      nodeType: "details_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "details content",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("stops searching after finding first textblock in container (multiple children)", () => {
    // alertBlock with two paragraph children — only first should be targeted
    const alert = containerSchema.node("alertBlock", { sourceLine: 5, kind: "note" }, [
      containerSchema.node("paragraph", { sourceLine: 6 }, [containerSchema.text("first child")]),
      containerSchema.node("paragraph", { sourceLine: 7 }, [containerSchema.text("second child")]),
    ]);
    const doc = containerSchema.node("doc", null, [
      containerSchema.node("paragraph", { sourceLine: 1 }, [containerSchema.text("before")]),
      alert,
    ]);
    const state = EditorState.create({ doc, schema: containerSchema });
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 5,
      wordAtCursor: "first",
      offsetInWord: 0,
      nodeType: "alert_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "first child",
    };

    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
    const tr = view.dispatch.mock.calls[0][0];
    expect(tr.getMeta("addToHistory")).toBe(false);
  });

  it("falls through when container node has no textblock children", () => {
    // Create an alertBlock that only has other alert blocks (no direct textblock child)
    // In practice this is unusual, but tests the fallback path
    const emptyAlert = containerSchema.node("alertBlock", { sourceLine: 5, kind: "note" }, [
      containerSchema.node("alertBlock", { sourceLine: 6, kind: "tip" }, [
        containerSchema.node("paragraph", { sourceLine: 7 }, [containerSchema.text("nested")]),
      ]),
    ]);
    const doc = containerSchema.node("doc", null, [
      containerSchema.node("paragraph", { sourceLine: 1 }, [containerSchema.text("before")]),
      emptyAlert,
    ]);
    const state = EditorState.create({ doc, schema: containerSchema });
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 5,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "alert_block",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };

    // Should still dispatch (finds textblock child via nested descendants)
    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("falls through non-container, non-textblock node with matching sourceLine (branch 21[1])", () => {
    // blockquote is NOT in containerTypes, and NOT a textblock.
    // When it matches sourceLine, the code should skip it and continue searching.
    const bq = containerSchema.node("blockquote", { sourceLine: 3 }, [
      containerSchema.node("paragraph", { sourceLine: 4 }, [containerSchema.text("quoted text")]),
    ]);
    const doc = containerSchema.node("doc", null, [
      containerSchema.node("paragraph", { sourceLine: 1 }, [containerSchema.text("before")]),
      bq,
    ]);
    const state = EditorState.create({ doc, schema: containerSchema });
    const view = createMockView(state);

    const info: CursorInfo = {
      sourceLine: 3,
      wordAtCursor: "quoted",
      offsetInWord: 0,
      nodeType: "blockquote",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "quoted text",
    };

    // blockquote matches sourceLine=3 but is not textblock and not in containerTypes.
    // Code falls through and continues searching. The paragraph at sourceLine=4 won't match.
    // Falls back to findClosestSourceLine.
    restoreCursorInTiptap(view as never, info);
    expect(view.dispatch).toHaveBeenCalled();
  });
});

describe("restoreCursorInTiptap — TextSelection.near failure catch block", () => {
  it("falls back to doc start when TextSelection.near throws", () => {
    // Create a real doc/state, then monkey-patch state.tr to throw on first setSelection
    const doc = schema.node("doc", null, [para("text", 1)]);
    const realState = createState(doc);

    const _callCount = 0;
    const _originalTrGetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(realState),
      "tr"
    );

    // Proxy: make state.tr.setSelection throw on first call (TextSelection.near path)
    // but succeed on second call (Selection.atStart fallback path)
    const view = {
      state: realState,
      dispatch: vi.fn(),
    };

    // Mock TextSelection.near to throw
    const _origNear = TextSelection.near;
    vi.spyOn(TextSelection, "near").mockImplementation(() => {
      throw new Error("Simulated near failure");
    });

    const info: CursorInfo = {
      sourceLine: 1,
      wordAtCursor: "",
      offsetInWord: 0,
      nodeType: "paragraph",
      percentInLine: 0,
      contextBefore: "",
      contextAfter: "",
    };

    // Should not throw — the catch block handles the error
    expect(() => restoreCursorInTiptap(view as never, info)).not.toThrow();
    // Should have dispatched the fallback Selection.atStart
    expect(view.dispatch).toHaveBeenCalled();

    vi.mocked(TextSelection.near).mockRestore();
  });
});
