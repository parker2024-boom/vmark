// WI-RA22.6 — after a source-mode Replace, the match counter follows the match
// CodeMirror selected: the first match at or after the end of the inserted
// text, wrapping to the first — the rule WYSIWYG search uses
// (src/plugins/search/matchSelection.ts). Real CodeMirror, real store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { search } from "@codemirror/search";
import { useUIStore } from "@/stores/uiStore";
import { useSourceEditorSearch } from "./useSourceEditorSearch";

let view: EditorView;

function mountEditor(doc: string): void {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [search()] }),
    parent: document.body,
  });
}

function openSearch(query: string, replaceText: string, currentIndex: number): void {
  useUIStore.setState((s) => ({
    search: {
      ...s.search,
      isOpen: true,
      query,
      replaceText,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
      matchCount: 0,
      currentIndex,
    },
  }));
}

/** Put CodeMirror's selection on [from, to) and the counter on `index`, as Next would. */
function selectMatch(from: number, to: number, index: number): void {
  view.dispatch({ selection: { anchor: from, head: to } });
  useUIStore.setState((s) => ({ search: { ...s.search, currentIndex: index } }));
}

function replaceCurrent(): void {
  window.dispatchEvent(new Event("search:replace-current"));
  vi.advanceTimersByTime(100); // the two animation frames the hook waits for
}

function selection(): [number, number] {
  const { from, to } = view.state.selection.main;
  return [from, to];
}

/** jsdom has no layout and does not define these on Range; scrolling to a match only needs them to exist. */
const LAYOUT_STUBS: Array<[object, string, () => unknown]> = [
  [Range.prototype, "getClientRects", () => []],
  [Range.prototype, "getBoundingClientRect", () => new DOMRect()],
];

beforeEach(() => {
  vi.useFakeTimers();
  for (const [target, name, value] of LAYOUT_STUBS) {
    if (name in target) throw new Error(`jsdom now defines ${name}; drop this stub`);
    Object.defineProperty(target, name, { configurable: true, value });
  }
});

afterEach(() => {
  view.destroy();
  for (const [target, name] of LAYOUT_STUBS) Reflect.deleteProperty(target, name);
  vi.useRealTimers();
});

describe("source-mode Replace keeps the counter on the selected match", () => {
  it("skips a replacement that contains the query", () => {
    mountEditor("a x a y a");
    openSearch("a", "aa", 0);
    renderHook(() => useSourceEditorSearch({ current: view }));
    selectMatch(0, 1, 0);

    replaceCurrent();

    expect(view.state.doc.toString()).toBe("aa x a y a");
    expect(selection()).toEqual([5, 6]);
    expect(useUIStore.getState().search.matchCount).toBe(4);
    expect(useUIStore.getState().search.currentIndex).toBe(2);
    // The counter update must not navigate the editor somewhere else.
    expect(selection()).toEqual([5, 6]);
  });

  it("leaves Next working after a Replace, counter and selection in step", () => {
    mountEditor("a x a y a");
    openSearch("a", "aa", 0);
    renderHook(() => useSourceEditorSearch({ current: view }));
    selectMatch(0, 1, 0);
    replaceCurrent();

    useUIStore.getState().searchFindNext();

    expect(useUIStore.getState().search.currentIndex).toBe(3);
    expect(selection()).toEqual([9, 10]);
  });

  it("wraps to the first match after replacing the last one", () => {
    mountEditor("a x a");
    openSearch("a", "aa", 1);
    renderHook(() => useSourceEditorSearch({ current: view }));
    selectMatch(4, 5, 1);

    replaceCurrent();

    expect(view.state.doc.toString()).toBe("a x aa");
    expect(selection()).toEqual([0, 1]);
    expect(useUIStore.getState().search.currentIndex).toBe(0);
  });

  it("keeps the same index when the replacement does not contain the query", () => {
    mountEditor("a x a y a");
    openSearch("a", "b", 1);
    renderHook(() => useSourceEditorSearch({ current: view }));
    selectMatch(4, 5, 1);

    replaceCurrent();

    expect(view.state.doc.toString()).toBe("a x b y a");
    expect(selection()).toEqual([8, 9]);
    expect(useUIStore.getState().search.matchCount).toBe(2);
    expect(useUIStore.getState().search.currentIndex).toBe(1);
  });

  it("handles CJK text the same way", () => {
    mountEditor("文 甲 文 乙 文");
    openSearch("文", "文字", 0);
    renderHook(() => useSourceEditorSearch({ current: view }));
    selectMatch(0, 1, 0);

    replaceCurrent();

    expect(view.state.doc.toString()).toBe("文字 甲 文 乙 文");
    expect(selection()).toEqual([5, 6]);
    expect(useUIStore.getState().search.currentIndex).toBe(1);
  });

  it("follows the selection when Replace only moved to the next match", () => {
    mountEditor("a x a y a");
    openSearch("a", "aa", 0);
    renderHook(() => useSourceEditorSearch({ current: view }));
    view.dispatch({ selection: { anchor: 2 } }); // a caret, not a match

    replaceCurrent();

    expect(view.state.doc.toString()).toBe("a x a y a");
    expect(selection()).toEqual([4, 5]);
    expect(useUIStore.getState().search.currentIndex).toBe(1);
  });
});
