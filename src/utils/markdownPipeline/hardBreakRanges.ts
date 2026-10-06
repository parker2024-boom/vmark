/**
 * Hard breaks in markdown SOURCE — where a parse of the text as written puts
 * them.
 *
 * Purpose: answer "which bytes of this text are hard breaks?" for code that
 * must rewrite a hard break's spelling in text it did not serialize (a Source
 * mode buffer, a file opened and saved without an edit).
 *
 * A line that ends in a backslash or in two spaces is a hard break only inside
 * a paragraph, and only when it is not the paragraph's last line. The same
 * bytes are a LaTeX row separator in `$$` math, a row of a table, a line of an
 * HTML block, of indented or fenced code, of frontmatter, or a literal
 * backslash before a soft break. No pattern over lines can tell these apart,
 * so none is used: the answer is the set of `break` nodes the parser produces.
 *
 * Key decisions:
 *   - The `source-position` dialect is the parser, because its positions
 *     address the text as written. `parse()` only — a `break` is born at
 *     tokenization and no transform creates one.
 *   - What this returns are CANDIDATES, not the last word. The document parse
 *     rewrites its source first (bare list markers, unclosed `$$` fences,
 *     `\[ \]` math), so it can read a line differently from this one. A caller
 *     that edits these ranges must hold the result to the document parse, as
 *     hardBreakRespell.ts does; nothing here makes an edit safe on its own.
 *   - One of those differences is cheap to remove up front: `\[ … \]` and
 *     `\( … \)` are math to the document parse and prose to this one. A break
 *     reported inside such a span is math content, and one on the line
 *     directly above a display span is the last line of its paragraph, which
 *     the math block ends. Both are dropped, using the same span finder — and
 *     the same probe behind it — that the document parse rewrites from. That
 *     spares the caller an edit its verification would refuse, and with it
 *     every other edit to the document: display math under a line that ends
 *     in a backslash is common in machine-written markdown. The finder costs
 *     a second parse, so it runs only for text that contains a delimiter at
 *     all.
 *   - A break whose first byte is neither a backslash nor a space is skipped,
 *     not classified by default.
 *   - A node whose range is absent or untrusted is refused through
 *     `canonicalRangeOf`, never defaulted: a guessed offset edits the wrong
 *     text.
 *   - Input nested too deeply to parse yields `null` ("cannot tell"), decided
 *     by the pipeline's own nesting scan before parsing rather than by
 *     catching a stack overflow.
 *
 * @coordinates-with hardBreakRespell.ts — rewrites the spelling of what this finds
 * @coordinates-with parser/processorFactory.ts — the `source-position` processor
 * @coordinates-with parser/mathDelimiterSpans.ts — the `\[ \]` / `\( \)` spans
 * @coordinates-with positionTrust.ts — which ranges may authorize an edit
 * @coordinates-with nestingDepth.ts — the depth the parser survives
 * @module utils/markdownPipeline/hardBreakRanges
 */

import { createMarkdownProcessor } from "./parser/processorFactory";
import { findMathDelimiterSpans } from "./parser/mathDelimiterSpans";
import { MAX_NESTING_DEPTH, maxContainerDepth } from "./nestingDepth";
import { canonicalRangeOf, type PositionedNode } from "./positionTrust";

/** One hard break in the source text. */
export interface HardBreakRange {
  /** Offset of the break's first character: its backslash, or its first space. */
  start: number;
  /** Offset just past the break's line ending. */
  end: number;
  /** How it is spelled in the source. */
  spelling: "backslash" | "twoSpaces";
  /**
   * True when nothing precedes the break on its line — it opens its
   * paragraph, or follows another line ending. Such a break cannot be spelled
   * with trailing spaces: the line would be whitespace only, which is a blank
   * line.
   */
  startsLine: boolean;
}

interface InlineNode extends PositionedNode {
  value?: string;
  children?: InlineNode[];
}

let processor: ReturnType<typeof createMarkdownProcessor> | undefined;

/** True when `previous` leaves nothing on the line before the node after it. */
function endsItsLine(previous: InlineNode | undefined): boolean {
  if (previous === undefined || previous.type === "break") return true;
  // A text VALUE has container prefixes stripped, so its last character is the
  // line ending itself even inside a blockquote or list item.
  return previous.type === "text" && /[\r\n]$/.test(previous.value ?? "");
}

/**
 * Every hard break in `markdown`, in source order, or `null` when the text
 * nests too deeply to parse.
 *
 * `markdown` is editor text: LF line endings, no BOM.
 */
export function findHardBreakRanges(markdown: string): HardBreakRange[] | null {
  if (maxContainerDepth(markdown) > MAX_NESTING_DEPTH) return null;

  processor ??= createMarkdownProcessor();
  const tree = processor.parse(markdown) as InlineNode;

  const found: HardBreakRange[] = [];
  // Iterative: a recursive walk would spend stack in proportion to nesting.
  const pending: InlineNode[] = [tree];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const children = node.children ?? [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.type !== "break") {
        if (child.children) pending.push(child);
        continue;
      }
      const range = canonicalRangeOf(child);
      const spelling = range === null ? null : spellingAt(markdown, range.start);
      if (range === null || spelling === null) continue;
      found.push({
        start: range.start,
        end: range.end,
        spelling,
        startsLine: endsItsLine(children[index - 1]),
      });
    }
  }
  found.sort((a, b) => a.start - b.start);
  return dropBreaksInDelimiterMath(markdown, found);
}

/** How the break starting at `offset` is spelled, or null when it is neither form. */
function spellingAt(markdown: string, offset: number): HardBreakRange["spelling"] | null {
  const first = markdown[offset];
  if (first === "\\") return "backslash";
  if (first === " ") return "twoSpaces";
  return null;
}

/** True when only spaces and tabs lie in `markdown` from `from` up to `to`. */
function onlyIndentBetween(markdown: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (markdown[index] !== " " && markdown[index] !== "\t") return false;
  }
  return true;
}

/**
 * `breaks` (sorted by start) without those that `\[ … \]` / `\( … \)` math
 * makes something else to the document parse:
 *   - one INSIDE a span is math content;
 *   - one on the line directly above a DISPLAY span ends its paragraph there —
 *     the math block the span becomes interrupts it — so its backslash is
 *     literal and its trailing spaces are nothing.
 *
 * One forward sweep over both lists. Spans arrive sorted by start and may
 * nest, so the sweep tracks the furthest end among the spans already opened.
 */
function dropBreaksInDelimiterMath(markdown: string, breaks: HardBreakRange[]): HardBreakRange[] {
  if (breaks.length === 0) return breaks;
  if (!markdown.includes("\\[") && !markdown.includes("\\(")) return breaks;

  const spans = findMathDelimiterSpans(markdown);
  if (spans.length === 0) return breaks;

  const kept: HardBreakRange[] = [];
  let next = 0;
  let coveredUntil = 0;
  for (const candidate of breaks) {
    while (next < spans.length && spans[next].start <= candidate.start) {
      if (spans[next].end > coveredUntil) coveredUntil = spans[next].end;
      next += 1;
    }
    if (candidate.start < coveredUntil) continue;
    // `spans[next]` is now the first span that starts after this break.
    const below = spans[next];
    if (
      below?.kind === "display" &&
      onlyIndentBetween(markdown, candidate.end, below.start)
    ) {
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}
