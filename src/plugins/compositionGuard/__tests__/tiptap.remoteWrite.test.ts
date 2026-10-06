// @vitest-environment node
// WI-RA10A.2 — the place a composition began follows the document: a write
// that is not the user's typing moves it or retires it, and the cleanup after
// the composition deletes the leftover preedit text and nothing else.
/**
 * The guard recorded where a composition started as a raw position and never
 * touched it again, while admitting document changes for as long as the
 * composition lasted. A write that landed in between — an AI client's edit, a
 * content sync — moved the text under that position, and the cleanup then
 * removed whatever "looked like pinyin" in front of the composed text: the
 * user's own English, twelve characters of it in the reported case.
 *
 * Runs the real plugin inside a real EditorState. Only the view is a stand-in:
 * it holds the state and applies what is dispatched, which is all the guard
 * asks of it. Nothing in the guard or in `utils/imeGuard` is mocked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Plugin, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { compositionGuardExtension } from "../tiptap";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    heading: { group: "block", content: "text*", toDOM: () => ["h1", 0] },
    text: { inline: true },
  },
});

const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const h = (text = "") => schema.node("heading", null, text ? [schema.text(text)] : []);
const doc = (...blocks: PMNode[]) => schema.node("doc", null, blocks);

type DomHandler = (view: EditorView, event?: unknown) => boolean;

/** The stand-in view: a state, and a dispatch that applies to it. */
interface Harness {
  view: EditorView;
  events: Record<"compositionstart" | "compositionupdate" | "compositionend" | "blur", DomHandler>;
  /** The document as text, blocks separated by a bar. */
  text: () => string;
  /** Run the animation frames requested so far. */
  runFrames: () => void;
}

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

function mount(document: PMNode, cursor: number): Harness {
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
    dispatch(tr: Transaction) {
      holder.state = holder.state.apply(tr);
    },
  };
  const view = holder as unknown as EditorView;
  const handlers = (plugins[0]!.props as { handleDOMEvents: Harness["events"] }).handleDOMEvents;
  return {
    view,
    events: handlers,
    text: () => {
      const blocks: string[] = [];
      holder.state.doc.forEach((block) => blocks.push(block.textContent));
      return blocks.join("|");
    },
    runFrames: () => {
      const due = frames;
      frames = [];
      for (const frame of due) frame(0);
    },
  };
}

/** What the IME does to the document: an edit ProseMirror tags as composition. */
function imeInsert(harness: Harness, text: string): void {
  const { state } = harness.view;
  harness.view.dispatch(state.tr.insertText(text).setMeta("composition", 1));
}

/** Replace the preedit text in front of the cursor with the committed text. */
function imeCommit(harness: Harness, preedit: string, committed: string): void {
  const { state } = harness.view;
  const to = state.selection.from;
  harness.view.dispatch(
    state.tr.insertText(committed, to - preedit.length, to).setMeta("composition", 1),
  );
}

/** WebKit's failure: the committed text is appended and the preedit stays. */
function imeCommitLeavingPreedit(harness: Harness, committed: string): void {
  imeInsert(harness, committed);
}

/** A write by something other than the user's typing, with no marker on it. */
function foreignInsert(harness: Harness, pos: number, text: string): void {
  harness.view.dispatch(harness.view.state.tr.insertText(text, pos));
}

/** A programmatic edit as the app's writers mark one. */
function programmaticInsert(harness: Harness, pos: number, text: string): void {
  harness.view.dispatch(
    harness.view.state.tr.insertText(text, pos).setMeta("addToHistory", true),
  );
}

/** A content load: the whole document replaced, as a sync or an AI write does. */
function loadDocument(harness: Harness, next: PMNode): void {
  const { state } = harness.view;
  harness.view.dispatch(
    state.tr
      .replaceWith(0, state.doc.content.size, next.content)
      .setMeta("addToHistory", false)
      .setMeta("preventUpdate", true),
  );
}

function compose(harness: Harness, preedit: string): void {
  harness.events.compositionstart(harness.view);
  imeInsert(harness, preedit);
  harness.events.compositionupdate(harness.view, { data: preedit });
}

function finish(harness: Harness, committed: string): void {
  harness.events.compositionend(harness.view, { data: committed });
  harness.runFrames();
}

describe("a write that lands before the composition", () => {
  it("does not make the cleanup delete the user's own text", () => {
    // "X|" — compose at the end, while "hello world " arrives at the start.
    const harness = mount(doc(p("X")), 2);
    compose(harness, "nihao");
    foreignInsert(harness, 1, "hello world ");
    imeCommit(harness, "nihao", "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("hello world X你好");
  });

  it("still removes the leftover preedit, and exactly that", () => {
    const harness = mount(doc(p("X")), 2);
    compose(harness, "nihao");
    foreignInsert(harness, 1, "hello world ");
    imeCommitLeavingPreedit(harness, "你好");
    expect(harness.text()).toBe("hello world Xnihao你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("hello world X你好");
  });

  it("follows a write in an earlier block", () => {
    const harness = mount(doc(p("first"), p("second")), 14);
    compose(harness, "zhongwen");
    foreignInsert(harness, 1, "a much longer opening paragraph: ");
    imeCommitLeavingPreedit(harness, "中文");

    finish(harness, "中文");

    expect(harness.text()).toBe("a much longer opening paragraph: first|second中文");
  });

  it("follows several writes, one after another", () => {
    const harness = mount(doc(p("X")), 2);
    compose(harness, "ni");
    foreignInsert(harness, 1, "one ");
    imeInsert(harness, "hao");
    foreignInsert(harness, 1, "two ");
    foreignInsert(harness, 1, "three ");
    imeCommitLeavingPreedit(harness, "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("three two one X你好");
  });

  it("follows a deletion in front of it", () => {
    const harness = mount(doc(p("hello world X")), 14);
    compose(harness, "nihao");
    const { state } = harness.view;
    harness.view.dispatch(state.tr.delete(1, 7));
    imeCommitLeavingPreedit(harness, "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("world X你好");
  });

  it("counts positions in UTF-16 units across emoji and supplementary-plane Han", () => {
    // Each of 😀 and 𠮷 is two units; a position off by one lands inside a pair.
    const harness = mount(doc(p("\u{1F600}\u{20BB7}前文")), 7);
    compose(harness, "zhongwen");
    foreignInsert(harness, 1, "插入\u{1F600}\u{20BB7}");
    imeCommitLeavingPreedit(harness, "中文");

    finish(harness, "中文");

    expect(harness.text()).toBe("插入\u{1F600}\u{20BB7}\u{1F600}\u{20BB7}前文中文");
  });

  it("leaves a write that lands AFTER the composition where it is", () => {
    const harness = mount(doc(p("X"), p("tail")), 2);
    compose(harness, "nihao");
    foreignInsert(harness, harness.view.state.doc.content.size - 1, " appended");
    imeCommitLeavingPreedit(harness, "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("X你好|tail appended");
  });
});

describe("a write that lands exactly where the composition began", () => {
  it("is kept when it is a programmatic edit: it is not the user's preedit", () => {
    // An empty paragraph: the composition starts at its first position, and
    // that is also where an edit to "the start of the paragraph" goes.
    const harness = mount(doc(p()), 1);
    harness.events.compositionstart(harness.view);
    programmaticInsert(harness, 1, "hello world ");
    harness.view.dispatch(
      harness.view.state.tr.insertText("你好", 13).setMeta("composition", 1),
    );

    finish(harness, "你好");

    expect(harness.text()).toBe("hello world 你好");
  });

  it("is still cleaned up when it is the IME's own text", () => {
    const harness = mount(doc(p()), 1);
    compose(harness, "nihao");
    imeCommitLeavingPreedit(harness, "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("你好");
  });

  it("is still cleaned up when the IME replaces its preedit from the start", () => {
    const harness = mount(doc(p("keep ")), 6);
    compose(harness, "n");
    imeCommit(harness, "n", "ni");
    imeCommit(harness, "ni", "nihao");
    imeCommitLeavingPreedit(harness, "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("keep 你好");
  });
});

describe("a write that replaces the text the composition began in", () => {
  it("retires the composition: nothing in the loaded document is deleted", () => {
    const harness = mount(doc(p()), 1);
    compose(harness, "nihao");
    loadDocument(harness, doc(p("hello world 你好")));

    finish(harness, "你好");

    expect(harness.text()).toBe("hello world 你好");
  });

  it("retires it when a programmatic edit replaces only the block around it", () => {
    const harness = mount(doc(p("before"), p("X"), p("after")), 10);
    compose(harness, "nihao");
    const { state } = harness.view;
    // Replace the whole middle paragraph, composition and all.
    harness.view.dispatch(
      state.tr.replaceWith(8, 16, p("replaced nihao 你好")).setMeta("addToHistory", true),
    );

    finish(harness, "你好");

    expect(harness.text()).toBe("before|replaced nihao 你好|after");
  });

  it("retires it when the replacement carries no marker at all", () => {
    // Neither the composition's input nor a marked write: its origin is
    // unknown, and the cleanup does not act on a guess.
    const harness = mount(doc(p("before"), p("X"), p("after")), 10);
    compose(harness, "nihao");
    const { state } = harness.view;
    harness.view.dispatch(state.tr.replaceWith(8, 16, p("replaced nihao 你好")));

    finish(harness, "你好");

    expect(harness.text()).toBe("before|replaced nihao 你好|after");
  });

  it("keeps the composition when the IME's own change rebuilds its block", () => {
    // WebKit can tear out and rebuild the whole paragraph a composition is in;
    // ProseMirror reports that as one change spanning the node, tagged as
    // composition input. The composition is still there, at the same offset.
    const harness = mount(doc(p("keep "), p()), 8);
    harness.events.compositionstart(harness.view);
    const { state } = harness.view;
    harness.view.dispatch(state.tr.replaceWith(7, 9, p("lu")).setMeta("composition", 1));
    harness.events.compositionupdate(harness.view, { data: "lu" });
    const rebuilt = harness.view.state;
    harness.view.dispatch(rebuilt.tr.replaceWith(7, 11, p("lu路")).setMeta("composition", 1));

    finish(harness, "路");

    expect(harness.text()).toBe("keep |路");
  });

  it("stays retired through later writes", () => {
    const harness = mount(doc(p()), 1);
    compose(harness, "nihao");
    loadDocument(harness, doc(p("loaded")));
    foreignInsert(harness, 7, " text nihao你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("loaded text nihao你好");
  });

  it("does not carry over to the next composition", () => {
    const harness = mount(doc(p()), 1);
    compose(harness, "nihao");
    loadDocument(harness, doc(p("loaded ")));
    finish(harness, "你好");

    const { state } = harness.view;
    harness.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 8)));
    compose(harness, "zhongwen");
    imeCommitLeavingPreedit(harness, "中文");
    finish(harness, "中文");

    expect(harness.text()).toBe("loaded 中文");
  });
});

describe("the heading-split guard uses the same followed position", () => {
  it("still rejects the split after a write has moved the heading", () => {
    // WebKit splits a heading when a candidate is accepted. The guard rejects
    // that transaction — if it still knows the composition is in a heading.
    const harness = mount(doc(p("a"), h("Title")), 9);
    compose(harness, "biaoti");
    foreignInsert(harness, 1, "a long paragraph that pushes the heading far along ");
    const before = harness.view.state;
    const headingEnd = before.doc.content.size - 1;

    harness.view.dispatch(before.tr.split(headingEnd, 1, [{ type: schema.nodes.paragraph! }]));

    expect(harness.view.state.doc.childCount).toBe(2);
    expect(harness.view.state.doc.eq(before.doc)).toBe(true);
  });

  it("lets the same split through once the composition is over", () => {
    const harness = mount(doc(p("a"), h("Title")), 9);
    compose(harness, "biaoti");
    imeCommit(harness, "biaoti", "标题");
    finish(harness, "标题");
    const before = harness.view.state;

    harness.view.dispatch(
      before.tr.split(before.doc.content.size - 1, 1, [{ type: schema.nodes.paragraph! }]),
    );

    expect(harness.view.state.doc.childCount).toBe(3);
  });
});

describe("a composition with no interference behaves as before", () => {
  it("removes leftover preedit at the end of a paragraph", () => {
    const harness = mount(doc(p("abc ")), 5);
    compose(harness, "nihao");
    imeCommitLeavingPreedit(harness, "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("abc 你好");
  });

  it("deletes nothing when the IME replaced its preedit cleanly", () => {
    const harness = mount(doc(p("abc ")), 5);
    compose(harness, "nihao");
    imeCommit(harness, "nihao", "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("abc 你好");
  });

  it("deletes nothing when text follows the composition", () => {
    const harness = mount(doc(p("abc def")), 5);
    compose(harness, "nihao");
    imeCommitLeavingPreedit(harness, "你好");

    finish(harness, "你好");

    expect(harness.text()).toBe("abc nihao你好def");
  });

  it("handles two compositions in a row, each from its own start", () => {
    const harness = mount(doc(p("a ")), 3);
    compose(harness, "ni");
    imeCommitLeavingPreedit(harness, "你");
    finish(harness, "你");
    compose(harness, "hao");
    imeCommitLeavingPreedit(harness, "好");
    finish(harness, "好");

    expect(harness.text()).toBe("a 你好");
  });

  it("drops the frame of a composition that a newer one has replaced", () => {
    const harness = mount(doc(p("a ")), 3);
    compose(harness, "ni");
    imeCommitLeavingPreedit(harness, "你");
    harness.events.compositionend(harness.view, { data: "你" });
    // A second composition starts before the first one's frame has run.
    compose(harness, "hao");
    harness.runFrames();

    // The first cleanup did not run against the second composition's state.
    expect(harness.text()).toBe("a ni你hao");
  });

  it("forgets the composition on blur", () => {
    const harness = mount(doc(p("a ")), 3);
    compose(harness, "nihao");
    imeCommitLeavingPreedit(harness, "你好");
    harness.events.blur(harness.view);
    harness.runFrames();

    expect(harness.text()).toBe("a nihao你好");
  });
});
