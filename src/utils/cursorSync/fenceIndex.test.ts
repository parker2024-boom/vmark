// @vitest-environment node
// WI-RA10B.3 — the fence index answers exactly what the whole-document scan
// answered, and stays right through every kind of edit.
import { describe, it, expect } from "vitest";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import { fenceStartLineAt, sourceFenceIndex } from "./fenceIndex";

/**
 * The rule the cursor anchors have always used, written the slow way: read
 * every line from the top, toggling on a fence of the kind that is open.
 * Returns the 1-based line of the open fence, or null.
 */
function scanFromTop(text: string, lineNumber: number): number | null {
  const lines = text.split("\n");
  let open: string | null = null;
  let openLine = -1;
  for (let i = 0; i < lineNumber && i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    const kind = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : null;
    if (kind === null) continue;
    if (open === null) {
      open = kind;
      openLine = i + 1;
    } else if (open === kind) {
      open = null;
      openLine = -1;
    }
  }
  return open === null ? null : openLine;
}

const indexed = (doc: string) => EditorState.create({ doc, extensions: [sourceFenceIndex] });
const plain = (doc: string) => EditorState.create({ doc });

/** Both ways of asking — with the field installed and without — for one line. */
function ask(doc: string, lineNumber: number): Array<number | null> {
  return [fenceStartLineAt(indexed(doc), lineNumber), fenceStartLineAt(plain(doc), lineNumber)];
}

describe("fenceStartLineAt", () => {
  it.each([
    { name: "no fence at all", doc: "hello\nworld", line: 1, expected: null },
    { name: "a line inside a backtick block", doc: "```js\nconst x = 1;\n```", line: 2, expected: 1 },
    { name: "a line inside a tilde block", doc: "~~~python\nprint('hi')\n~~~", line: 2, expected: 1 },
    { name: "a line after a closed block", doc: "```\ncode\n```\noutside", line: 4, expected: null },
    { name: "a line after a closed tilde block", doc: "~~~\ninside\n~~~\noutside", line: 4, expected: null },
    { name: "the first of two blocks", doc: "```\nblock1\n```\n```\nblock2\n```", line: 2, expected: 1 },
    { name: "the second of two blocks", doc: "```\nblock1\n```\n```\nblock2\n```", line: 5, expected: 4 },
    { name: "a tilde line inside a backtick block", doc: "```\ncode\n~~~\nstill code\n```", line: 4, expected: 1 },
    { name: "a backtick line inside a tilde block", doc: "~~~\n```\nstill code\n~~~", line: 3, expected: 1 },
    { name: "the opening fence line itself", doc: "```\ncode\n```", line: 1, expected: 1 },
    { name: "the closing fence line itself", doc: "```\ncode\n```", line: 3, expected: null },
    { name: "an empty document", doc: "", line: 1, expected: null },
    { name: "an indented fence", doc: "text\n  ```\ncode\n  ```", line: 3, expected: 2 },
    { name: "a tab-indented fence", doc: "\t~~~\ncode", line: 2, expected: 1 },
    { name: "an unclosed block running to the end", doc: "a\n```\nb\nc", line: 4, expected: 2 },
    { name: "two backticks are not a fence", doc: "``\ncode", line: 2, expected: null },
    { name: "backticks after text are not a fence", doc: "a ```\ncode", line: 2, expected: null },
    { name: "a longer fence run still counts", doc: "`````\ncode", line: 2, expected: 1 },
    { name: "CJK content inside a block", doc: "```\n中文代码\n```", line: 2, expected: 1 },
  ])("$name", ({ doc, line, expected }) => {
    expect(ask(doc, line)).toEqual([expected, expected]);
    expect(scanFromTop(doc, line)).toBe(expected);
  });

  it("reads a line number past the end as the last line", () => {
    expect(ask("```\ncode", 99)).toEqual([1, 1]);
  });

  it("answers null below the first line", () => {
    expect(ask("```\ncode", 0)).toEqual([null, null]);
    expect(ask("```\ncode", -3)).toEqual([null, null]);
  });

  it("splits CRLF input into the same lines the editor shows", () => {
    expect(ask("```\r\ncode\r\n```\r\nafter", 2)).toEqual([1, 1]);
    expect(ask("```\r\ncode\r\n```\r\nafter", 4)).toEqual([null, null]);
  });
});

describe("sourceFenceIndex — kept current through edits", () => {
  /** Every line of `state` answers as a scan from the top of its text would. */
  function expectMatchesScan(state: EditorState): void {
    const text = state.doc.toString();
    for (let line = 1; line <= state.doc.lines; line += 1) {
      const got = fenceStartLineAt(state, line);
      if (got !== scanFromTop(text, line)) {
        throw new Error(
          `line ${line}: index says ${got}, scan says ${scanFromTop(text, line)} in ${JSON.stringify(text)}`,
        );
      }
    }
  }

  const edit = (doc: string, changes: ChangeSpec): EditorState => {
    const state = indexed(doc).update({ changes }).state;
    expectMatchesScan(state);
    return state;
  };

  it("typing a fence above opens a block over the lines below", () => {
    const state = edit("\ncode\nmore", { from: 0, insert: "```" });
    expect(fenceStartLineAt(state, 3)).toBe(1);
  });

  it("breaking a fence line apart closes the block it opened", () => {
    const state = edit("```\ncode", { from: 2, to: 3 });
    expect(fenceStartLineAt(state, 2)).toBeNull();
  });

  it("deleting the line break before a fence merges it into the previous line", () => {
    const state = edit("text\n```\ncode", { from: 4, to: 5 });
    expect(fenceStartLineAt(state, 2)).toBeNull();
  });

  it("inserting a line break before trailing backticks makes them a fence", () => {
    const state = edit("text```\ncode", { from: 4, insert: "\n" });
    expect(fenceStartLineAt(state, 3)).toBe(2);
  });

  it("an insert at the end of the line above a fence leaves the fence in place", () => {
    const state = edit("text\n```\ncode", { from: 4, insert: " more\nand more" });
    expect(fenceStartLineAt(state, 4)).toBe(3);
  });

  it("two changes on one line are read once", () => {
    const state = edit("a b c\n```\ncode", [
      { from: 1, insert: "\n```\n" },
      { from: 3, insert: "\n~~~\n" },
    ]);
    expect(state.field(sourceFenceIndex).markers.map((marker) => marker.kind)).toEqual(["`", "~", "`"]);
  });

  it("several changes across the document shift the fences between them", () => {
    edit("one\n```\ntwo\n```\nthree\n~~~\nfour\n~~~\nfive", [
      { from: 0, insert: "zero\n" },
      { from: 12, to: 15, insert: "```\nx\n```" },
      { from: 37, insert: "\n```" },
    ]);
  });

  it("replacing the whole document rebuilds the index", () => {
    const state = edit("```\nold\n```", { from: 0, to: 11, insert: "new\n~~~\nbody" });
    expect(fenceStartLineAt(state, 3)).toBe(2);
  });

  it("emptying the document empties the index", () => {
    const state = edit("```\ncode\n```", { from: 0, to: 12 });
    expect(state.field(sourceFenceIndex).markers).toEqual([]);
  });

  it("typing inside a line keeps the same index", () => {
    const before = indexed("intro\n```\ncode\n```\noutro");
    const after = before.update({ changes: { from: 2, insert: "xyz" } }).state;
    expect(after.field(sourceFenceIndex)).toBe(before.field(sourceFenceIndex));
    expectMatchesScan(after);
  });

  it("new lines in one place, then another, then removed again, move the fences below", () => {
    let state = indexed("intro\n```\ncode\n```\nbetween\n~~~\nmore\n~~~\noutro");
    const step = (changes: ChangeSpec) => {
      state = state.update({ changes }).state;
      expectMatchesScan(state);
    };
    step({ from: 5, insert: "\n" });
    step({ from: 6, insert: "\n" });
    expect(fenceStartLineAt(state, 5)).toBe(4);
    // A second place, while the first displacement is still pending.
    step({ from: state.doc.line(7).to, insert: "\na\nb" });
    expect(fenceStartLineAt(state, 11)).toBe(10);
    step({ from: 5, to: 7 });
    expect(fenceStartLineAt(state, 9)).toBe(8);
    // Below the last fence nothing moves.
    step({ from: state.doc.length, insert: "\ntail" });
    expect(fenceStartLineAt(state, state.doc.lines)).toBeNull();
  });

  it("a selection-only transaction keeps the same index", () => {
    const before = indexed("```\ncode\n```");
    const after = before.update({ selection: { anchor: 5 } }).state;
    expect(after.field(sourceFenceIndex)).toBe(before.field(sourceFenceIndex));
  });

  it("stays equal to a scan from the top through 2,000 random edits", () => {
    // A fixed-seed generator: the same edits every run, so a failure reproduces.
    let seed = 0x2f6e2b1;
    const random = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    const PIECES = ["```", "~~~", "  ```js", "\t~~~", "``", "a ``` b", "text", "中文", "", "\n", "\n", "`", "~"];
    const piece = () => PIECES[random(PIECES.length)];
    const text = (parts: number) => Array.from({ length: parts }, piece).join(random(2) ? "\n" : "");

    let state = indexed(text(12));
    for (let step = 0; step < 2000; step += 1) {
      const length = state.doc.length;
      const count = 1 + random(3);
      const cuts = Array.from({ length: count * 2 }, () => random(length + 1)).sort((a, b) => a - b);
      const changes: ChangeSpec[] = [];
      for (let i = 0; i < count; i += 1) {
        // Overlapping ranges are invalid; consecutive pairs of sorted cuts never overlap.
        const from = cuts[i * 2];
        const to = random(3) === 0 ? from : cuts[i * 2 + 1];
        changes.push({ from, to, insert: random(4) === 0 ? "" : text(1 + random(3)) });
      }
      state = state.update({ changes }).state;
      expectMatchesScan(state);
      if (state.doc.length > 400) state = indexed(text(6));
    }
    expect(state.field(sourceFenceIndex, false)).toBeDefined();
  });
});
