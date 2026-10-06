// WI-RA24.2 — the Source-mode find counter: every count is CodeMirror's, and
// the current match keeps its place by position through edits. Real
// CodeMirror, real uiStore search slice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useUIStore } from "@/stores/uiStore";
import {
  createSourceSearchRecount,
  publishSourceMatches,
  sourceMatchPlace,
  sourceSearchPlace,
} from "./sourceSearchCounter";

const views: EditorView[] = [];

function editor(doc: string, tracked = true): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: tracked ? [sourceSearchPlace] : [] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function openFind(query: string, currentIndex = -1): void {
  useUIStore.setState((s) => ({
    search: { ...s.search, isOpen: true, query, caseSensitive: false, wholeWord: false, useRegex: false, currentIndex },
  }));
}

const counter = () => [useUIStore.getState().search.currentIndex, useUIStore.getState().search.matchCount];

beforeEach(() => {
  vi.useFakeTimers();
  useUIStore.setState(useUIStore.getInitialState(), true);
});

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.useRealTimers();
});

describe("publishSourceMatches", () => {
  it("publishes CodeMirror's count and the index the caller picks", () => {
    const view = editor("cat\ncat\na cat");
    publishSourceMatches(view, { ...useUIStore.getState().search, query: "^cat", useRegex: true }, (m) => m.length - 1);
    expect(counter()).toEqual([1, 2]);
  });

  it("publishes no current match when there are none", () => {
    const view = editor("dog");
    publishSourceMatches(view, { ...useUIStore.getState().search, query: "cat" }, () => -1);
    expect(counter()).toEqual([-1, 0]);
  });
});

describe("sourceMatchPlace", () => {
  it("is null before anything was counted, and for an index past the matches", () => {
    const view = editor("cat cat");
    expect(sourceMatchPlace(view, 0)).toBeNull();
    publishSourceMatches(view, { ...useUIStore.getState().search, query: "cat" }, () => 0);
    expect(sourceMatchPlace(view, 2)).toBeNull();
    expect(sourceMatchPlace(view, -1)).toBeNull();
  });

  it("follows a match through insertions before it, and stays put for edits after it", () => {
    const view = editor("x cat y cat");
    publishSourceMatches(view, { ...useUIStore.getState().search, query: "cat" }, () => 1);
    expect(sourceMatchPlace(view, 1)).toBe(8);
    view.dispatch({ changes: { from: 0, insert: "猫猫" } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: " tail" } });
    expect(sourceMatchPlace(view, 1)).toBe(10);
  });

  it("maps a deleted match to where it was", () => {
    const view = editor("a cat b cat");
    publishSourceMatches(view, { ...useUIStore.getState().search, query: "cat" }, () => 0);
    view.dispatch({ changes: { from: 2, to: 5 } });
    expect(sourceMatchPlace(view, 0)).toBe(2);
  });

  it("forgets the place when it could not see an edit, instead of mapping through the wrong ones", () => {
    const view = editor("a cat", false);
    publishSourceMatches(view, { ...useUIStore.getState().search, query: "cat" }, () => 0);
    view.dispatch({ changes: { from: 0, insert: "zz" } });
    expect(sourceMatchPlace(view, 0)).toBeNull();
  });
});

describe("createSourceSearchRecount", () => {
  it("recounts once after typing pauses, resuming at the current match's place", () => {
    const view = editor("cat one\ncat two\ncat three");
    openFind("cat");
    publishSourceMatches(view, useUIStore.getState().search, () => 1); // on "cat two"
    const recount = createSourceSearchRecount();

    view.dispatch({ changes: { from: 0, insert: "cat " } });
    recount.schedule(view);
    view.dispatch({ changes: { from: 0, insert: "cat " } });
    recount.schedule(view);
    vi.advanceTimersByTime(299);
    expect(counter()).toEqual([1, 3]); // not yet

    vi.advanceTimersByTime(1);
    expect(counter()).toEqual([3, 5]); // still "cat two"
  });

  it.each([
    ["the find bar is closed", false, "cat"],
    ["the query is empty", true, ""],
  ])("does nothing when %s", (_label, isOpen, query) => {
    const view = editor("cat cat");
    useUIStore.setState((s) => ({ search: { ...s.search, isOpen, query, matchCount: 9, currentIndex: 4 } }));
    const recount = createSourceSearchRecount();
    recount.schedule(view);
    vi.advanceTimersByTime(1000);
    expect(counter()).toEqual([4, 9]);
  });

  it("reads the query fresh when it fires, and stops if the bar closed meanwhile", () => {
    const view = editor("cat cat");
    openFind("cat");
    const recount = createSourceSearchRecount();
    recount.schedule(view);
    useUIStore.getState().searchClose();
    vi.advanceTimersByTime(1000);
    expect(useUIStore.getState().search.matchCount).toBe(0);
  });

  it("cancel drops a pending recount", () => {
    const view = editor("cat cat");
    openFind("cat");
    const recount = createSourceSearchRecount();
    recount.schedule(view);
    recount.cancel();
    vi.advanceTimersByTime(1000);
    expect(counter()).toEqual([-1, 0]);
  });
});
