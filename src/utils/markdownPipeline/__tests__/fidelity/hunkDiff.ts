/**
 * Line-hunk differ for the round-trip fidelity gate.
 *
 * Purpose: answer "what did the pipeline change about the author's text?" in
 * units a human can review and a rule can classify. Consecutive changed lines
 * are grouped into one hunk, so a reformatted table reads as a single deviation
 * rather than six independent ones.
 *
 * Why a local LCS instead of a diff dependency: the corpus documents are small
 * (tens of lines), the gate needs no rendering or fuzzy matching, and adding a
 * runtime dependency for ~40 lines of table walk is dependency debt the project
 * rules ask us to justify rather than incur.
 *
 * @coordinates-with roundtripFidelity.test.ts — the gate that consumes hunks
 * @coordinates-with normalizationRules.ts — classifies each hunk
 * @module utils/markdownPipeline/__tests__/fidelity/hunkDiff
 */

/** One contiguous divergence: the author's lines, and what came back. */
export interface Hunk {
  /** Lines as the author wrote them (empty for a pure insertion). */
  before: string[];
  /** Lines the pipeline produced (empty for a pure deletion). */
  after: string[];
}

/**
 * Longest-common-subsequence table over two line arrays.
 * `lcs[i][j]` = length of the LCS of `a[i..]` and `b[j..]`.
 */
function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** One step of the edit script: a line kept, removed, or added. */
interface Op {
  kind: "same" | "del" | "ins";
  line: string;
}

/** The LCS edit script turning `a` into `b`. */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  const table = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      // Prefer the direction the LCS says preserves more shared lines. On a
      // tie consume from `before` first, so a replacement reads as
      // before→after rather than as an insertion followed by a deletion.
      ops.push({ kind: "del", line: a[i] });
      i += 1;
    } else {
      ops.push({ kind: "ins", line: b[j] });
      j += 1;
    }
  }
  // Tail: whatever remains on either side is one trailing divergence.
  for (; i < a.length; i += 1) ops.push({ kind: "del", line: a[i] });
  for (; j < b.length; j += 1) ops.push({ kind: "ins", line: b[j] });
  return ops;
}

/**
 * Slide the pure run at `[start, end)` one line at a time in `step` direction
 * across unchanged lines identical to its trailing edge. Returns the script
 * with the run moved if that makes it touch another change, else `null`.
 *
 * Such a slide is the same edit: LCS leaves the choice open whenever the run's
 * edge equals the unchanged line beside it — typically a blank line, as in a
 * re-spaced loose list — and one choice splits a single change in two.
 */
function slideToNeighbour(ops: readonly Op[], start: number, end: number, step: -1 | 1): Op[] | null {
  const moved = ops.slice();
  let s = start;
  let e = end;
  for (;;) {
    const beside = step < 0 ? s - 1 : e;
    const edge = step < 0 ? e - 1 : s;
    const next = moved[beside];
    if (next === undefined) return null;
    if (next.kind !== "same") return moved;
    if (next.line !== moved[edge].line) return null;
    // Rotate: the unchanged line beside the run joins it, and the run's far
    // edge (the same text) becomes the unchanged line.
    moved[beside] = { kind: moved[edge].kind, line: next.line };
    moved[edge] = { kind: "same", line: next.line };
    s += step;
    e += step;
  }
}

/** Join each pure insertion or deletion run to a neighbouring change it can slide to. */
function compact(script: readonly Op[]): Op[] {
  let ops = script.slice();
  let start = 0;
  while (start < ops.length) {
    if (ops[start].kind === "same") {
      start += 1;
      continue;
    }
    let end = start;
    while (end < ops.length && ops[end].kind !== "same") end += 1;
    const kind = ops[start].kind;
    const pure = ops.slice(start, end).every((op) => op.kind === kind);
    const joined = pure
      ? (slideToNeighbour(ops, start, end, -1) ?? slideToNeighbour(ops, start, end, 1))
      : null;
    if (joined) {
      // Two changes became one, so there are fewer runs: rescanning ends.
      ops = joined;
      start = 0;
      continue;
    }
    start = end;
  }
  return ops;
}

/**
 * Diff two documents by line, grouping consecutive changes into hunks.
 *
 * A pure insertion or deletion that the LCS placed across an identical
 * unchanged line from another change is slid to join it (`compact`), so one
 * change is classified as one hunk.
 *
 * Returns `[]` when the documents are identical — the fidelity case.
 */
export function hunkDiff(before: string, after: string): Hunk[] {
  const hunks: Hunk[] = [];
  let pending: Hunk | null = null;
  for (const op of compact(editScript(before.split("\n"), after.split("\n")))) {
    if (op.kind === "same") {
      if (pending) hunks.push(pending);
      pending = null;
      continue;
    }
    pending ??= { before: [], after: [] };
    (op.kind === "del" ? pending.before : pending.after).push(op.line);
  }
  if (pending) hunks.push(pending);
  return hunks;
}

/** Render hunks as a reviewable unified-style block for failure output. */
export function formatHunks(hunks: readonly Hunk[]): string {
  return hunks
    .map((h) => {
      const minus = h.before.map((l) => `      - ${JSON.stringify(l)}`);
      const plus = h.after.map((l) => `      + ${JSON.stringify(l)}`);
      return [...minus, ...plus].join("\n");
    })
    .join("\n      ~~~\n");
}
