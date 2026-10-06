// @vitest-environment node
// WI-RA24.2 — Source-mode matches come from CodeMirror's own search engine, so
// the counter agrees with Next, Previous and Replace.
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  buildSourceSearchQuery,
  findSourceMatches,
  type SourceSearchParams,
} from "./sourceEditorSearch";

function params(query: string, options: Partial<SourceSearchParams> = {}): SourceSearchParams {
  return { query, replaceText: "", caseSensitive: false, wholeWord: false, useRegex: false, ...options };
}

const find = (doc: string, query: string, options: Partial<SourceSearchParams> = {}) =>
  findSourceMatches(EditorState.create({ doc }), params(query, options));

const count = (doc: string, query: string, options: Partial<SourceSearchParams> = {}) =>
  find(doc, query, options).length;

describe("findSourceMatches", () => {
  it.each([
    ["an empty query", "hello world", ""],
    ["a query that is not there", "hello world", "xyz"],
    ["an empty document", "", "hello"],
    ["a query longer than the document", "hi", "hello world"],
  ])("finds nothing for %s", (_label, doc, query) => {
    expect(find(doc, query)).toEqual([]);
  });

  it("returns positions in document order", () => {
    expect(find("abc abc", "abc")).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it("does not overlap matches", () => {
    expect(count("aaa", "aa")).toBe(1);
  });

  it.each([
    ["folds case by default", "Hello HELLO hello", "hello", {}, 3],
    ["keeps case when asked", "Hello HELLO hello", "hello", { caseSensitive: true }, 1],
    ["folds non-ASCII case", "Ärger ärger ÄRGER", "ärger", {}, 3],
    ["respects Whole Word", "cat concatenate category cat", "cat", { wholeWord: true }, 2],
    ["takes regex metacharacters literally outside regex mode", "file.txt filetxt $100 func()", "file.txt", {}, 1],
    ["matches CJK", "你好世界你好", "你好", {}, 2],
    ["matches astral characters", "hello 🎉 world 🎉", "🎉", {}, 2],
    ["counts every space", "   ", " ", {}, 3],
  ] as const)("%s", (_label, doc, query, options, expected) => {
    expect(count(doc, query, options)).toBe(expected);
  });

  describe("agrees with the engine where a hand-built RegExp did not", () => {
    it("anchors ^ and $ at every line, as CodeMirror does", () => {
      expect(count("cat\ncat\na cat", "^cat", { useRegex: true })).toBe(2);
      expect(count("a cat\nthe cat\ncats", "cat$", { useRegex: true })).toBe(2);
    });

    it("applies Whole Word in regex mode too", () => {
      expect(count("cat concat cat", "c.t", { useRegex: true, wholeWord: true })).toBe(2);
    });

    it("reads a typed \\n in a plain query as a line break", () => {
      expect(find("cat\ndog\ncat\\ndog", "cat\\ndog")).toEqual([{ from: 0, to: 7 }]);
    });

    it("crosses a line break only where the pattern names one: a dot does not, \\n does", () => {
      expect(count("abc\ndef", "abc.def", { useRegex: true })).toBe(0);
      expect(count("abc\ndef", "abc\\ndef", { useRegex: true })).toBe(1);
    });
  });

  it("finds nothing for an unfinished regex instead of throwing", () => {
    expect(find("cat (cat", "(cat", { useRegex: true })).toEqual([]);
    expect(find("cat [x", "[x", { useRegex: true })).toEqual([]);
  });

  it("counts zero-length regex matches as the engine yields them", () => {
    expect(find("abxc", "x*", { useRegex: true })).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 2, to: 3 },
      { from: 4, to: 4 },
    ]);
  });
});

describe("buildSourceSearchQuery", () => {
  it("carries every setting and the replacement into CodeMirror's query", () => {
    const query = buildSourceSearchQuery({
      query: "猫",
      replaceText: "狗",
      caseSensitive: true,
      wholeWord: true,
      useRegex: true,
    });
    expect([query.search, query.replace, query.caseSensitive, query.wholeWord, query.regexp]).toEqual([
      "猫",
      "狗",
      true,
      true,
      true,
    ]);
  });
});
