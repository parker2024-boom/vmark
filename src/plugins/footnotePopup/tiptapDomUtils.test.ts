/**
 * Footnote DOM Utilities Tests
 *
 * Tests for scrollToPosition, jumpToFootnoteDefinition, findFootnoteDefinition,
 * findFootnoteReference, getFootnoteRefFromTarget, and getFootnoteDefFromTarget.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import {
  scrollToPosition,
  jumpToFootnoteDefinition,
  findFootnoteDefinition,
  findFootnoteReference,
  getFootnoteRefFromTarget,
  getFootnoteDefFromTarget,
} from "./tiptapDomUtils";
import { scrollBehavior } from "@/utils/motion";

// Minimal schema with footnote nodes
const schema = new Schema({
  nodes: {
    doc: { content: "(block | footnote_definition)+" },
    paragraph: { group: "block", content: "inline*" },
    footnote_reference: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { label: { default: "1" } },
    },
    footnote_definition: {
      content: "block+",
      attrs: { label: { default: "1" } },
    },
    text: { group: "inline" },
  },
});

function p(text?: string) {
  return schema.node("paragraph", null, text ? [schema.text(text)] : []);
}

function fnRef(label: string) {
  return schema.node("footnote_reference", { label });
}

function fnDef(label: string, text?: string) {
  return schema.node("footnote_definition", { label }, [p(text ?? `Footnote ${label}`)]);
}

function pWithRef(text: string, label: string) {
  return schema.node("paragraph", null, [schema.text(text), fnRef(label)]);
}

function createView(doc: ReturnType<typeof schema.node>) {
  const state = EditorState.create({ doc, schema });
  return { state } as unknown as import("@tiptap/pm/view").EditorView;
}

describe("findFootnoteDefinition", () => {
  it("returns null for doc without footnote definitions", () => {
    const view = createView(schema.node("doc", null, [p("Hello")]));
    expect(findFootnoteDefinition(view, "1")).toBeNull();
  });

  it("finds definition by label", () => {
    const view = createView(
      schema.node("doc", null, [
        p("Hello"),
        fnDef("1", "First note"),
        fnDef("2", "Second note"),
      ])
    );

    const result = findFootnoteDefinition(view, "1");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("First note");
    expect(result!.pos).toBeGreaterThan(0);
  });

  it("finds second definition", () => {
    const view = createView(
      schema.node("doc", null, [
        p("Hello"),
        fnDef("1", "First"),
        fnDef("2", "Second"),
      ])
    );

    const result = findFootnoteDefinition(view, "2");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Second");
  });

  it("returns 'Empty footnote' for definition with no text content", () => {
    const view = createView(
      schema.node("doc", null, [p("Hello"), fnDef("1", "")])
    );

    // Empty text trims to "", so fallback
    const result = findFootnoteDefinition(view, "1");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Empty footnote");
  });

  it("returns null for non-matching label", () => {
    const view = createView(
      schema.node("doc", null, [p("Hello"), fnDef("1", "Note")])
    );
    expect(findFootnoteDefinition(view, "99")).toBeNull();
  });
});

describe("findFootnoteReference", () => {
  it("returns null for doc without references", () => {
    const view = createView(schema.node("doc", null, [p("Hello")]));
    expect(findFootnoteReference(view, "1")).toBeNull();
  });

  it("finds reference position by label", () => {
    const view = createView(
      schema.node("doc", null, [pWithRef("Text", "1")])
    );

    const pos = findFootnoteReference(view, "1");
    expect(pos).not.toBeNull();
    expect(pos).toBeGreaterThan(0);
  });

  it("returns null for non-matching label", () => {
    const view = createView(
      schema.node("doc", null, [pWithRef("Text", "1")])
    );
    expect(findFootnoteReference(view, "99")).toBeNull();
  });

  it("finds first occurrence when multiple refs have same label", () => {
    const view = createView(
      schema.node("doc", null, [
        pWithRef("First", "1"),
        pWithRef("Second", "1"),
      ])
    );

    const pos = findFootnoteReference(view, "1");
    expect(pos).not.toBeNull();
    // Should find the first one
    expect(pos).toBeGreaterThan(0);
  });
});

describe("scrollToPosition", () => {
  let mockEditorContent: {
    getBoundingClientRect: ReturnType<typeof vi.fn>;
    scrollTop: number;
    scrollTo: ReturnType<typeof vi.fn>;
    hasAttribute: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockEditorContent = {
      getBoundingClientRect: vi.fn(() => ({ top: 50 })),
      scrollTop: 200,
      scrollTo: vi.fn(),
      hasAttribute: vi.fn(() => false), // no deferred renders pending (settledScroll)
    };
  });

  /** A view inside `scroller` (or detached, for null). */
  function viewIn(scroller: unknown, coordsAtPos: ReturnType<typeof vi.fn>) {
    return {
      dom: { closest: vi.fn(() => scroller), firstElementChild: null },
      state: { doc: { content: { size: 100 } } },
      coordsAtPos,
    } as unknown as import("@tiptap/pm/view").EditorView;
  }

  it("scrolls the view's own scroll container to the position", () => {
    const view = viewIn(mockEditorContent, vi.fn(() => ({ top: 300, left: 100, bottom: 320 })));

    scrollToPosition(view, 10);

    expect(view.coordsAtPos).toHaveBeenCalledWith(10);
    expect(view.dom.closest).toHaveBeenCalledWith(".editor-content");
    expect(mockEditorContent.scrollTo).toHaveBeenCalledWith({
      // 300 - 50 + 200 - 100 = 350
      top: 350,
      behavior: scrollBehavior(),
    });
  });

  it("does nothing when coordsAtPos returns null-like", () => {
    const view = viewIn(mockEditorContent, vi.fn(() => null));

    scrollToPosition(view, 10);
    expect(mockEditorContent.scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing for a position past the end of the document", () => {
    const coordsAtPos = vi.fn(() => ({ top: 300 }));
    scrollToPosition(viewIn(mockEditorContent, coordsAtPos), 500);
    expect(coordsAtPos).not.toHaveBeenCalled();
    expect(mockEditorContent.scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing when the view is not inside an editor-content element", () => {
    // Should not throw
    scrollToPosition(viewIn(null, vi.fn(() => ({ top: 300 }))), 10);
  });
});

describe("jumpToFootnoteDefinition", () => {
  /** A live view inside a scroller; `events` records each side effect in order. */
  function liveView(doc: ReturnType<typeof schema.node>) {
    const events: string[] = [];
    let state = EditorState.create({ doc, schema });
    const scroller = {
      getBoundingClientRect: () => ({ top: 0 }),
      scrollTop: 0,
      scrollTo: vi.fn(() => { events.push("scroll"); }),
      hasAttribute: () => false,
    };
    const view = {
      dom: { closest: () => scroller, firstElementChild: null },
      get state() { return state; },
      dispatch: (tr: Transaction) => { events.push("select"); state = state.apply(tr); },
      focus: () => { events.push("focus"); },
      coordsAtPos: () => ({ top: 500 }),
    } as unknown as import("@tiptap/pm/view").EditorView;
    return { view, events, scroller };
  }

  const docWithDefs = () =>
    schema.node("doc", null, [pWithRef("See", "a"), p("Body"), fnDef("a", "Alpha"), fnDef("b", "Beta")]);

  it("selects the start of the definition's text, focuses, then scrolls", () => {
    const { view, events, scroller } = liveView(docWithDefs());
    const defPos = findFootnoteDefinition(view, "b")!.pos;

    expect(jumpToFootnoteDefinition(view, "b", defPos)).toBe(true);

    expect(events).toEqual(["select", "focus", "scroll"]);
    const { $from, empty } = view.state.selection;
    expect(empty).toBe(true);
    expect($from.node(-1).attrs.label).toBe("b");
    expect($from.parentOffset).toBe(0);
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another footnote's definition", (view: import("@tiptap/pm/view").EditorView) => findFootnoteDefinition(view, "a")!.pos],
    ["a non-definition node", () => 0],
    ["a position past the end of the document", (view: import("@tiptap/pm/view").EditorView) => view.state.doc.content.size + 50],
  ])("re-finds the definition by label when the stored position points at %s", (_case, stalePos) => {
    const { view, events } = liveView(docWithDefs());

    expect(jumpToFootnoteDefinition(view, "b", stalePos(view))).toBe(true);

    expect(events).toEqual(["select", "focus", "scroll"]);
    expect(view.state.selection.$from.node(-1).attrs.label).toBe("b");
  });

  it.each([
    ["the label has no definition", "zzz", 5],
    ["there is no stored position", "b", null],
  ])("does nothing when %s", (_case, label, pos) => {
    const { view, events } = liveView(docWithDefs());
    const before = view.state;

    expect(jumpToFootnoteDefinition(view, label, pos)).toBe(false);

    expect(events).toEqual([]);
    expect(view.state).toBe(before);
  });
});

describe("getFootnoteRefFromTarget", () => {
  it("returns null for null target", () => {
    expect(getFootnoteRefFromTarget(null)).toBeNull();
  });

  it("returns the closest footnote reference element", () => {
    const supEl = document.createElement("sup");
    supEl.setAttribute("data-type", "footnote_reference");
    supEl.setAttribute("data-label", "1");

    const span = document.createElement("span");
    supEl.appendChild(span);

    // closest() works on the element itself or ancestors
    expect(getFootnoteRefFromTarget(supEl)).toBe(supEl);
  });

  it("returns null for non-footnote elements", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);

    expect(getFootnoteRefFromTarget(div)).toBeNull();

    document.body.removeChild(div);
  });

  it("finds footnote ref from child element", () => {
    const supEl = document.createElement("sup");
    supEl.setAttribute("data-type", "footnote_reference");
    supEl.setAttribute("data-label", "2");
    document.body.appendChild(supEl);

    const innerSpan = document.createElement("span");
    supEl.appendChild(innerSpan);

    expect(getFootnoteRefFromTarget(innerSpan)).toBe(supEl);

    document.body.removeChild(supEl);
  });

  it("handles Text node target by using parentElement", () => {
    const supEl = document.createElement("sup");
    supEl.setAttribute("data-type", "footnote_reference");
    document.body.appendChild(supEl);

    const textNode = document.createTextNode("1");
    supEl.appendChild(textNode);

    expect(getFootnoteRefFromTarget(textNode)).toBe(supEl);

    document.body.removeChild(supEl);
  });

  it("returns null for text node without parentElement matching", () => {
    // Detached text node
    const detachedText = document.createTextNode("orphan");
    // parentElement is null for detached text nodes, but the function
    // goes through the Node branch — parentElement will be null
    expect(getFootnoteRefFromTarget(detachedText)).toBeNull();
  });
});

describe("getFootnoteDefFromTarget", () => {
  it("returns null for null target", () => {
    expect(getFootnoteDefFromTarget(null)).toBeNull();
  });

  it("returns the closest footnote definition element", () => {
    const dlEl = document.createElement("dl");
    dlEl.setAttribute("data-type", "footnote_definition");
    dlEl.setAttribute("data-label", "1");
    document.body.appendChild(dlEl);

    expect(getFootnoteDefFromTarget(dlEl)).toBe(dlEl);

    document.body.removeChild(dlEl);
  });

  it("returns null for non-footnote elements", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);

    expect(getFootnoteDefFromTarget(div)).toBeNull();

    document.body.removeChild(div);
  });

  it("finds footnote def from child element", () => {
    const dlEl = document.createElement("dl");
    dlEl.setAttribute("data-type", "footnote_definition");
    document.body.appendChild(dlEl);

    const dt = document.createElement("dt");
    dlEl.appendChild(dt);

    expect(getFootnoteDefFromTarget(dt)).toBe(dlEl);

    document.body.removeChild(dlEl);
  });
});
