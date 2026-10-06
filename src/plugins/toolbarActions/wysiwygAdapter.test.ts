/**
 * WYSIWYG toolbar adapter — routing AND outcome.
 *
 * Every action runs through the REAL handler modules against a real Tiptap
 * editor built from the production extension set (`runOnWysiwyg`), and the
 * assertion is the markdown the editor holds afterwards — not that a stub was
 * called. The null-context cases keep an editor double where the point is
 * "nothing to act on", and undo/redo/alerts keep one where the point is which
 * editor command the action maps to.
 *
 * Mocked: `sonner` (a third-party toast boundary, asserted on for Format
 * Table) and the debug loggers (production no-ops; see the parity suite for
 * the teardown race they cause).
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { Editor, type Editor as TiptapEditor } from "@tiptap/core";
import { SelectionRange } from "@tiptap/pm/state";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock("@/utils/debug", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => {}]));
});

import { toast } from "sonner";
import { performWysiwygToolbarAction, setWysiwygHeadingLevel } from "./wysiwygAdapter";
import type { WysiwygToolbarContext, MultiSelectionContext } from "./types";
import { runOnWysiwyg, disposeSurfaces, type Target } from "./__tests__/parity/surfaces";
import { createTiptapExtensions } from "@/services/assembly/createTiptapExtensions";
import { parseMarkdown, serializeMarkdown } from "@/utils/markdownPipeline";
import { MultiSelection } from "@/plugins/shared/MultiSelection";

afterAll(disposeSurfaces);

const baseContext: WysiwygToolbarContext = {
  surface: "wysiwyg",
  view: null,
  editor: null,
  context: null,
};

/** A chainable editor-command stub, for the cases that only check command mapping. */
const link = () => vi.fn().mockReturnThis();

function createMockEditor(overrides?: Record<string, unknown>) {
  return {
    commands: {
      undo: vi.fn(() => true),
      redo: vi.fn(() => true),
      insertAlertBlock: vi.fn(() => true),
      insertDetailsBlock: vi.fn(() => true),
    },
    chain: link(), focus: link(), setParagraph: link(), setHeading: link(), setCodeBlock: link(),
    setHorizontalRule: link(), insertTable: link(), insertContentAt: link(), setTextSelection: link(),
    state: { selection: { $from: { depth: 0 }, $to: { pos: 0 } } },
    run: vi.fn(() => true),
    ...overrides,
  } as unknown as TiptapEditor;
}

const disabledMultiSelection: MultiSelectionContext = {
  enabled: false,
  reason: "none",
  inCodeBlock: false,
  inTable: false,
  inList: false,
  inBlockquote: false,
  inHeading: false,
  inLink: false,
  inInlineMath: false,
  inFootnote: false,
  inImage: false,
  inTextblock: false,
  sameBlockParent: true,
  blockParentType: null,
};

const TABLE = "| a | b |\n| --- | --- |\n| c | d |";

describe("performWysiwygToolbarAction — no editor or view", () => {
  it("maps each alert action to its alert type", () => {
    const actions: Record<string, string> = {
      insertAlertNote: "NOTE",
      insertAlertTip: "TIP",
      insertAlertImportant: "IMPORTANT",
      insertAlertWarning: "WARNING",
      insertAlertCaution: "CAUTION",
    };
    for (const [action, alertType] of Object.entries(actions)) {
      const insertAlertBlock = vi.fn(() => true);
      const editor = { commands: { insertAlertBlock } } as unknown as TiptapEditor;
      expect(performWysiwygToolbarAction(action, { ...baseContext, editor })).toBe(true);
      expect(insertAlertBlock).toHaveBeenCalledWith(alertType);
    }
  });

  it("returns false for an unknown action", () => {
    expect(performWysiwygToolbarAction("unknownAction", { ...baseContext, editor: createMockEditor() })).toBe(false);
  });

  it("routes undo and redo to the editor's history commands", () => {
    const editor = createMockEditor();
    expect(performWysiwygToolbarAction("undo", { ...baseContext, editor })).toBe(true);
    expect(performWysiwygToolbarAction("redo", { ...baseContext, editor })).toBe(true);
    expect(editor.commands.undo).toHaveBeenCalledTimes(1);
    expect(editor.commands.redo).toHaveBeenCalledTimes(1);
  });

  it("rejects non-integer and out-of-range heading levels", () => {
    const editor = createMockEditor();
    for (const bad of [-1, 7, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setWysiwygHeadingLevel({ ...baseContext, editor }, bad)).toBe(false);
    }
    expect(editor.chain).not.toHaveBeenCalled();
  });

  it("setWysiwygHeadingLevel returns false with no editor", () => {
    expect(setWysiwygHeadingLevel(baseContext, 1)).toBe(false);
  });

  it.each([
    "undo", "redo",
    "bold", "italic", "underline", "strikethrough", "highlight", "superscript", "subscript", "code",
    "clearFormatting", "increaseHeading", "decreaseHeading",
    "bulletList", "orderedList", "indent", "outdent", "removeList",
    "insertDivider", "insertTable", "insertFootnote", "insertDetails", "insertBlockquote",
    "toggleQuoteStyle", "insertBulletList", "insertOrderedList", "insertTaskList",
    "selectWord", "selectLine", "selectBlock", "expandSelection",
    "addRowAbove", "addRow", "addColLeft", "addCol", "deleteRow", "deleteCol", "deleteTable",
    "alignLeft", "alignCenter", "alignRight", "alignAllLeft", "alignAllCenter", "alignAllRight",
    "nestBlockquote", "unnestBlockquote", "removeBlockquote",
    "insertAlertNote", "insertAlertTip", "insertAlertImportant", "insertAlertWarning", "insertAlertCaution",
  ])("%s with nothing to act on returns false", (action) => {
    expect(performWysiwygToolbarAction(action, baseContext)).toBe(false);
  });
});

/** Run on the real editor and return the markdown, failing loudly on a thrown error. */
function run(markdown: string, target: Target, action: string) {
  const result = runOnWysiwyg(markdown, target, action);
  expect(result.error).toBeUndefined();
  return result;
}

describe("performWysiwygToolbarAction — real editor outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["bold", "hello **world**\n"],
    ["italic", "hello *world*\n"],
    ["underline", "hello ++world++\n"],
    ["strikethrough", "hello ~~world~~\n"],
    ["highlight", "hello ==world==\n"],
    ["superscript", "hello ^world^\n"],
    ["subscript", "hello ~world~\n"],
    ["code", "hello `world`\n"],
    ["link:wiki", "hello [[world]]\n"],
    ["transformUppercase", "hello WORLD\n"],
  ])("%s transforms the selected word", (action, expected) => {
    const result = run("hello world", { select: "world" }, action);
    expect(result.accepted).toBe(true);
    expect(result.markdown).toBe(expected);
  });

  it("clearFormatting removes inline marks from the selection", () => {
    expect(run("hello **world**", { select: "world" }, "clearFormatting").markdown).toBe("hello world\n");
  });

  it.each([
    ["transformLowercase", "HELLO WORLD", { select: "WORLD" }, "HELLO world\n"],
    ["transformTitleCase", "hello world", { select: "hello world" }, "Hello World\n"],
    ["transformToggleCase", "Hello", { select: "Hello" }, "HELLO\n"],
  ] as const)("%s rewrites the selection's case", (action, md, target, expected) => {
    expect(run(md, target, action).markdown).toBe(expected);
  });

  it.each([
    ["increaseHeading", "### Title\n\n"],
    ["decreaseHeading", "# Title\n\n"],
  ])("%s steps the heading level", (action, expected) => {
    expect(run("## Title", { caret: "Title" }, action).markdown).toBe(expected);
  });

  it.each([
    ["bulletList", "item", "item", "- item\n\n"],
    ["orderedList", "item", "item", "1. item\n\n"],
    ["taskList", "item", "item", "- [ ] item\n\n"],
    ["indent", "- one\n- two", "two", "- one\n  - two\n\n"],
    ["outdent", "- one\n  - two", "two", "- one\n- two\n\n"],
    ["removeList", "- one", "one", "one\n\n"],
    ["insertBulletList", "para", "para", "- para\n\n"],
    ["insertOrderedList", "para", "para", "1. para\n\n"],
    ["insertTaskList", "para", "para", "- [ ] para\n\n"],
  ])("%s reshapes the list structure", (action, md, caret, expected) => {
    expect(run(md, { caret }, action).markdown).toBe(expected);
  });

  it.each([
    ["addRowAbove", "| a | b |\n| - | - |\n|   |   |\n| c | d |\n\n"],
    ["addRow", "| a | b |\n| - | - |\n| c | d |\n|   |   |\n\n"],
    ["addColLeft", "|   | a | b |\n| - | - | - |\n|   | c | d |\n\n"],
    ["addCol", "| a |   | b |\n| - | - | - |\n| c |   | d |\n\n"],
    ["deleteCol", "| b |\n| - |\n| d |\n\n"],
    ["alignCenter", "|  a  | b |\n| :-: | - |\n|  c  | d |\n\n"],
    ["alignAllRight", "|  a |  b |\n| -: | -: |\n|  c |  d |\n\n"],
  ])("%s edits the table at the caret", (action, expected) => {
    expect(run(TABLE, { caret: "c" }, action).markdown).toBe(expected);
  });

  it("deleteRow removes the caret row", () => {
    expect(run(`${TABLE}\n| e | f |`, { caret: "c" }, "deleteRow").markdown).toBe("| a | b |\n| - | - |\n| e | f |\n\n");
  });

  it("deleteTable removes the whole table", () => {
    expect(run(`${TABLE}\n\nafter`, { caret: "c" }, "deleteTable").markdown).toBe("after\n");
  });

  it("formatTable inside a table reports success", () => {
    expect(run(TABLE, { caret: "c" }, "formatTable").accepted).toBe(true);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("formatTable with nothing to format still dispatches, and says nothing changed", () => {
    const result = run("para", { caret: "para" }, "formatTable");
    // Dispatched (true) so the toolbar shows no generic failure; the info
    // toast tells the user there was nothing to change.
    expect(result.accepted).toBe(true);
    expect(result.markdown).toBe("para\n");
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ["nestBlockquote", "> quoted", "> > quoted\n\n"],
    ["unnestBlockquote", "> > quoted", "> quoted\n\n"],
    ["removeBlockquote", "> quoted", "quoted\n\n"],
    ["insertBlockquote", "para", "> para\n\n"],
  ])("%s changes the quote depth", (action, md, expected) => {
    const caret = md.replace(/^[> ]+/, "");
    expect(run(md, { caret }, action).markdown).toBe(expected);
  });

  it.each([
    ["insertMath", "para\n\n$$\n$$\n\n"],
    ["insertDivider", "para\n\n---\n\n"],
    ["insertTable", "para\n\n|   |   |\n| - | - |\n|   |   |\n\n"],
    ["insertTableBlock", "para\n\n|   |   |\n| - | - |\n|   |   |\n\n"],
  ])("%s inserts its block AFTER the current one", (action, expected) => {
    expect(run("para", { caret: "para" }, action).markdown).toBe(expected);
  });

  it.each([
    ["insertDiagram", "```mermaid"],
    ["insertMarkmap", "```markmap"],
    ["insertGraphvizDiagram", "```dot"],
    ["insertDetails", "<details open>"],
    ["insertAlertNote", "> [!NOTE]"],
  ])("%s inserts its block after the paragraph", (action, fence) => {
    const { markdown } = run("para", { caret: "para" }, action);
    expect(markdown.startsWith("para\n\n")).toBe(true);
    expect(markdown).toContain(fence);
  });

  it("insertCodeBlock turns the paragraph into a code block", () => {
    expect(run("para", { caret: "para" }, "insertCodeBlock").markdown).toBe("```plaintext\npara\n```\n\n");
  });

  it("insertFootnote adds a reference and its definition", () => {
    expect(run("para", { caret: "para" }, "insertFootnote").markdown).toBe("[^1]para\n\n[^1]: \n\n");
  });

  it("insertInlineMath inserts an inline math node at the caret", () => {
    const { markdown, accepted } = run("para", { caret: "para" }, "insertInlineMath");
    expect(accepted).toBe(true);
    expect(markdown).not.toBe("para\n");
    expect(markdown).toContain("para");
  });

  it("toggleQuoteStyle converts straight quotes to curly ones", () => {
    expect(run('say "hi" now', { caret: "hi" }, "toggleQuoteStyle").markdown).toBe("say “hi” now\n");
  });

  it.each(["formatCJK", "formatCJKFile"])("%s spaces CJK and Latin text", (action) => {
    expect(run("中文English", { caret: "English" }, action).markdown).toBe("中文 English\n");
  });

  it.each(["removeTrailingSpaces", "collapseBlankLines"])("%s is accepted on a document", (action) => {
    expect(run("a\n\nb", { caret: "a" }, action).accepted).toBe(true);
  });

  it.each(["lineEndingsLF", "lineEndingsCRLF"])(
    "%s records nothing — and reports false — when no document tab is active",
    (action) => {
      const result = run("a", { caret: "a" }, action);
      expect(result.accepted).toBe(false);
      expect(result.markdown).toBe("a\n");
    },
  );

  it.each([
    ["selectWord", "hello world", "world"],
    ["selectBlock", "hello world\n\nnext", "hello world"],
  ])("%s selects around the caret", (action, md, selected) => {
    const result = run(md, { caret: "world" }, action);
    expect(result.markdown).toBe(`${md}\n`);
    expect(result.selectedText).toBe(selected);
  });

  it.each([
    ["moveLineUp", "two", "two\n\none\n"],
    ["moveLineDown", "one", "two\n\none\n"],
    ["deleteLine", "one", "two\n"],
  ])("%s moves or removes the caret block", (action, caret, expected) => {
    expect(run("one\n\ntwo", { caret }, action).markdown).toBe(expected);
  });

  it("duplicateLine repeats the caret line", () => {
    expect(run("one\n\ntwo", { caret: "one" }, "duplicateLine").markdown).toBe("one\\\none\n\ntwo\n");
  });

  it("link:bookmark accepts in a document with headings to link to", () => {
    const result = run("# Head\n\nhello world", { caret: "world" }, "link:bookmark");
    expect(result.accepted).toBe(true);
    expect(result.markdown).toBe("# Head\n\nhello world\n");
  });

  it("joinLines joins the caret block onto the previous one", () => {
    const result = run("one\n\ntwo", { caret: "two" }, "joinLines");
    expect(result.accepted).toBe(true);
    expect(result.markdown).toBe("onetwo\n");
  });

  it("joinLines at the start of the document has nothing to join", () => {
    expect(run("one\n\ntwo", { caret: "one" }, "joinLines").accepted).toBe(false);
  });

  it("removeBlankLines with no selection does nothing", () => {
    expect(run("one\n\ntwo", { caret: "one" }, "removeBlankLines").accepted).toBe(false);
  });

  it.each(["insertImage", "insertVideo", "insertAudio", "link"])(
    "%s accepts and leaves the document for its async picker",
    (action) => {
      const result = run("hello world", { select: "world" }, action);
      expect(result.accepted).toBe(true);
      expect(result.markdown).toBe("hello world\n");
    },
  );
});

/** A fresh production editor whose selection is a real multi-cursor selection. */
describe("multi-selection", () => {
  let editor: Editor;
  let element: HTMLElement;

  beforeAll(() => {
    element = document.createElement("div");
    document.body.appendChild(element);
    editor = new Editor({ element, extensions: createTiptapExtensions(), content: "" });
  });

  afterAll(async () => {
    editor.destroy();
    element.remove();
    // Lets deferred extension work run while the worker is still alive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  function load(markdown: string, carets: string[]): WysiwygToolbarContext {
    editor.commands.setContent(parseMarkdown(editor.schema, markdown).toJSON());
    const positions = carets.map((needle) => {
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (found < 0 && node.isText && node.text?.includes(needle)) found = pos + node.text.indexOf(needle);
      });
      expect(found).toBeGreaterThan(0);
      return found;
    });
    const { doc } = editor.state;
    const ranges = positions.map((p) => new SelectionRange(doc.resolve(p), doc.resolve(p)));
    editor.view.dispatch(editor.state.tr.setSelection(new MultiSelection(ranges, 0)));
    return { surface: "wysiwyg", view: editor.view, editor, context: null };
  }

  const markdown = () => serializeMarkdown(editor.schema, editor.state.doc);
  const multi: MultiSelectionContext = {
    ...disabledMultiSelection,
    enabled: true,
    reason: "multi",
    inTextblock: true,
    sameBlockParent: true,
  };

  // Each cursor's paragraph becomes its own list; adjacent lists alternate
  // their marker when serialized, so the marker is matched as a class.
  it.each([
    ["bulletList", [/^[-*+] one$/m, /^[-*+] two$/m]],
    ["orderedList", [/^1[.)] one$/m, /^1[.)] two$/m]],
  ])("%s applies at EVERY cursor", (action, lines) => {
    const ctx = load("one\n\ntwo", ["one", "two"]);
    expect(performWysiwygToolbarAction(action, { ...ctx, multiSelection: multi })).toBe(true);
    for (const line of lines) expect(markdown()).toMatch(line);
  });

  it("nestBlockquote nests the quote at every cursor", () => {
    const ctx = load("> one\n\nmid\n\n> two", ["one", "two"]);
    expect(performWysiwygToolbarAction("nestBlockquote", { ...ctx, multiSelection: multi })).toBe(true);
    expect(markdown()).toContain("> > one");
    expect(markdown()).toContain("> > two");
  });

  it("setWysiwygHeadingLevel turns every cursor's block into a heading", () => {
    const ctx = load("one\n\ntwo", ["one", "two"]);
    expect(setWysiwygHeadingLevel({ ...ctx, multiSelection: multi }, 2)).toBe(true);
    expect(markdown()).toContain("## one");
    expect(markdown()).toContain("## two");
  });

  it("a disallowed action is refused and the document is unchanged", () => {
    const ctx = load("one\n\ntwo", ["one", "two"]);
    const before = markdown();
    expect(performWysiwygToolbarAction("insertCodeBlock", { ...ctx, multiSelection: multi })).toBe(false);
    expect(markdown()).toBe(before);
  });

  it("a conditional action is refused when a cursor sits in a code block", () => {
    const ctx = load("one\n\ntwo", ["one", "two"]);
    const before = markdown();
    expect(setWysiwygHeadingLevel({ ...ctx, multiSelection: { ...multi, inCodeBlock: true } }, 2)).toBe(false);
    expect(performWysiwygToolbarAction("bold", { ...ctx, multiSelection: { ...multi, inCodeBlock: true } })).toBe(false);
    expect(markdown()).toBe(before);
  });
});
