// WI-RA21.3 — Replace keeps its place and never re-matches inserted text.
//
// After a Replace the plugin rescans, and every rescan reported the FIRST match
// as current — so a Replace on a middle match jumped back to the top, a
// replacement containing the query was itself the next "current" match, and
// pressing Replace again rewrote the text just inserted ("a" → "aa" → "aaa").
// A rescan after any edit while the bar was open lost the user's place too.
//
// A real EditorView with the production plugin; the find bar is a small host
// that behaves like the app's search slice (clamped report, wrapping next).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { bindHostSearch, type SearchQuery } from "@/plugins/shared/hostSearch";
import { searchExtension, SEARCH_DOC_CHANGE_DEBOUNCE_MS } from "./tiptap";

/** The app's search slice, reduced to what the plugin reads and reports. */
const bar: SearchQuery = {
  isOpen: true,
  query: "",
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  currentIndex: -1,
  replaceText: "",
  matchCount: 0,
};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

bindHostSearch({
  current: () => ({ ...bar }),
  reportMatches: (count, index) => {
    bar.matchCount = Math.max(0, count);
    bar.currentIndex = Math.min(Math.max(index, -1), bar.matchCount - 1);
    notify();
  },
  findNext: () => {
    if (bar.matchCount === 0) return;
    bar.currentIndex = bar.currentIndex + 1 >= bar.matchCount ? 0 : bar.currentIndex + 1;
    notify();
  },
  onChange: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: { inline: true },
  },
});

const extensionContext = {
  name: "search",
  options: {},
  storage: {},
  editor: {} as never,
  type: null as never,
  parent: undefined,
};

let view: EditorView | null = null;

function mount(text: string): EditorView {
  const plugins = searchExtension.config.addProseMirrorPlugins?.call(extensionContext as never) ?? [];
  const doc = schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]);
  view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ doc, schema, plugins }),
  });
  return view;
}

const text = (v: EditorView) => v.state.doc.textContent;

/** Let the deferred match report land (it is queued on a microtask). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SEARCH_DOC_CHANGE_DEBOUNCE_MS + 50);
  await Promise.resolve();
}

async function search(v: EditorView, query: string, replaceText: string): Promise<void> {
  bar.query = query;
  bar.replaceText = replaceText;
  notify();
  v.dispatch(v.state.tr);
  await settle();
}

async function next(): Promise<void> {
  bar.currentIndex = bar.currentIndex + 1 >= bar.matchCount ? 0 : bar.currentIndex + 1;
  notify();
  await settle();
}

function replace(): void {
  window.dispatchEvent(new Event("search:replace-current"));
}

/** The text of the match the editor highlights as current. */
function activeText(v: EditorView): string {
  return [...v.dom.querySelectorAll(".search-match-active")].map((el) => el.textContent).join("");
}

/** Where (in plain-text offsets) the current match starts, from the host's index. */
function currentOffset(v: EditorView, query: string): number {
  const all = [...text(v).matchAll(new RegExp(query, "g"))].map((m) => m.index);
  return all[bar.currentIndex] ?? -1;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  Object.assign(bar, { isOpen: true, query: "", replaceText: "", currentIndex: -1, matchCount: 0 });
  listeners.clear();
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

describe("Replace moves to the next match after the replaced range", () => {
  it("a Replace on the middle match lands on the match after it, not the first", async () => {
    const v = mount("cat one cat two cat three");
    await search(v, "cat", "dog");
    await next(); // the middle "cat"

    replace();
    await settle();

    expect(text(v)).toBe("cat one dog two cat three");
    expect(bar.matchCount).toBe(2);
    expect(bar.currentIndex).toBe(1);
    expect(currentOffset(v, "cat")).toBe(16); // "cat three"
    expect(activeText(v)).toBe("cat");
  });

  it("a replacement that contains the query is never the next match", async () => {
    const v = mount("a b a");
    await search(v, "a", "aa");

    replace();
    await settle();
    expect(text(v)).toBe("aa b a");
    expect(currentOffset(v, "a")).toBe(5); // the original second "a", not the inserted "aa"

    replace();
    await settle();
    expect(text(v)).toBe("aa b aa"); // each original replaced once — never "aaa b a"
  });

  it("holds when Replace is pressed again before the rescan delay has passed", async () => {
    const v = mount("x x x");
    await search(v, "x", "xx");

    replace();
    replace();
    replace();
    await settle();

    expect(text(v)).toBe("xx xx xx");
  });

  it("wraps to the first match when the last one is replaced", async () => {
    const v = mount("cat and cat");
    await search(v, "cat", "dog");
    await next(); // the last "cat"

    replace();
    await settle();

    expect(text(v)).toBe("cat and dog");
    expect(bar.currentIndex).toBe(0);
    expect(currentOffset(v, "cat")).toBe(0);
  });

  it("an empty replacement deletes the match and moves to the next", async () => {
    const v = mount("one, two, three");
    await search(v, ", ", "");

    replace();
    await settle();

    expect(text(v)).toBe("onetwo, three");
    expect(bar.currentIndex).toBe(0);
    expect(currentOffset(v, ", ")).toBe(6);
  });

  it("replacing the only match leaves no current match", async () => {
    const v = mount("just one cat");
    await search(v, "cat", "dog");

    replace();
    await settle();

    expect(text(v)).toBe("just one dog");
    expect(bar.matchCount).toBe(0);
    expect(bar.currentIndex).toBe(-1);
  });

  it("works the same for CJK text whose replacement contains the query", async () => {
    const v = mount("猫和猫头鹰，还有猫。");
    await search(v, "猫", "小猫");
    await next();

    replace();
    await settle();

    expect(text(v)).toBe("猫和小猫头鹰，还有猫。");
    expect(currentOffset(v, "猫")).toBe(9); // the last original 猫, not the inserted one
  });
});

describe("an edit while the bar is open keeps the current match", () => {
  it("typing elsewhere does not send the current match back to the first", async () => {
    const v = mount("cat one cat two cat three");
    await search(v, "cat", "dog");
    await next();
    await next(); // "cat three"

    v.dispatch(v.state.tr.insertText("> ", 1)); // at the very start of the paragraph
    await settle();

    expect(bar.matchCount).toBe(3);
    expect(bar.currentIndex).toBe(2);
    expect(currentOffset(v, "cat")).toBe(18);
  });
});

describe("Replace All", () => {
  it("replaces every original match once and never re-matches the inserted text", async () => {
    const v = mount("cat cat");
    await search(v, "cat", "catalog");

    window.dispatchEvent(new Event("search:replace-all"));
    await settle();

    expect(text(v)).toBe("catalog catalog");
  });
});
