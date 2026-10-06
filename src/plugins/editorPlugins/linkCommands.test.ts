import { describe, it, expect, vi, beforeEach } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";

// --- Mocks ---

const mockFindMarkRange = vi.fn<(...args: unknown[]) => { from: number; to: number } | null>(() => null);
vi.mock("@/plugins/syntaxReveal/marks", () => ({
  findMarkRange: (...args: unknown[]) => mockFindMarkRange(...args),
}));

const { handleUnlinkShortcut } = await import("./linkCommands");

// --- Schema ---

const schema = new Schema({
  nodes: {
    doc: { content: "block+", toDOM: () => ["div", 0] },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    wikiLink: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { value: { default: "" } },
      content: "text*",
      toDOM: () => ["span", { class: "wiki-link" }, 0],
    },
    text: { group: "inline", inline: true },
  },
  marks: {
    link: {
      attrs: { href: { default: "" } },
      toDOM: (mark) => ["a", { href: mark.attrs.href }, 0],
      parseDOM: [{ tag: "a[href]" }],
    },
  },
});

const mockCoords = { top: 100, bottom: 120, left: 200, right: 300 };

function createView(text: string, from: number, to?: number): EditorView {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
  let state = EditorState.create({ doc, schema });
  state = state.apply(
    state.tr.setSelection(
      TextSelection.create(state.doc, from, to ?? from)
    )
  );
  const container = document.createElement("div");
  const view = new EditorView(container, { state });
  view.coordsAtPos = vi.fn(() => mockCoords);
  return view;
}

function createViewWithLink(
  before: string,
  linkText: string,
  href: string,
  after: string,
  cursorInLink: boolean
): EditorView {
  const linkMark = schema.marks.link.create({ href });
  const nodes = [
    ...(before ? [schema.text(before)] : []),
    schema.text(linkText, [linkMark]),
    ...(after ? [schema.text(after)] : []),
  ];
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, nodes),
  ]);
  let state = EditorState.create({ doc, schema });

  const cursorPos = cursorInLink
    ? 1 + before.length + 1 // inside the link text
    : 1; // at the start
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, cursorPos))
  );
  const container = document.createElement("div");
  const view = new EditorView(container, { state });
  view.coordsAtPos = vi.fn(() => mockCoords);
  return view;
}

describe("handleUnlinkShortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMarkRange.mockReturnValue(null);
  });

  it("returns false when schema has no link mark", () => {
    const noLinkSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+", toDOM: () => ["div", 0] },
        paragraph: { content: "text*", toDOM: () => ["p", 0] },
        text: { inline: true },
      },
    });
    const doc = noLinkSchema.node("doc", null, [
      noLinkSchema.node("paragraph", null, [noLinkSchema.text("hello")]),
    ]);
    const state = EditorState.create({ doc, schema: noLinkSchema });
    const container = document.createElement("div");
    const view = new EditorView(container, { state });

    expect(handleUnlinkShortcut(view)).toBe(false);
    view.destroy();
  });

  it("returns false when cursor is not in a link", () => {
    const view = createView("hello world", 3);
    expect(handleUnlinkShortcut(view)).toBe(false);
    view.destroy();
  });

  it("removes link mark from text when cursor is in a link", () => {
    const view = createViewWithLink("", "linked text", "https://x.com", " after", true);
    mockFindMarkRange.mockReturnValue({ from: 1, to: 12 });

    const result = handleUnlinkShortcut(view);
    expect(result).toBe(true);

    // Link mark should be removed
    const hasMark = view.state.doc.rangeHasMark(1, 12, schema.marks.link);
    expect(hasMark).toBe(false);
    // Text should remain
    expect(view.state.doc.textContent).toContain("linked text");
    view.destroy();
  });

  it("returns false when findMarkRange returns null", () => {
    const view = createViewWithLink("", "linked", "https://y.com", "", true);
    mockFindMarkRange.mockReturnValue(null);
    expect(handleUnlinkShortcut(view)).toBe(false);
    view.destroy();
  });

  it("sets preventAutolink meta to stop autolink re-adding the mark (#584)", () => {
    const view = createViewWithLink("", "https://x.com", "https://x.com", " ", true);
    mockFindMarkRange.mockReturnValue({ from: 1, to: 14 });

    const origDispatch = view.dispatch.bind(view);
    let dispatchedTr: { getMeta: (key: string) => unknown } | null = null;
    vi.spyOn(view, "dispatch").mockImplementation((tr) => {
      dispatchedTr = tr as typeof dispatchedTr;
      origDispatch(tr);
    });

    handleUnlinkShortcut(view);
    expect(dispatchedTr).not.toBeNull();
    expect(dispatchedTr!.getMeta("preventAutolink")).toBe(true);
    view.destroy();
  });
});

