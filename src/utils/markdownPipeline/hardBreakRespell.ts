/**
 * Hard-break respelling in markdown SOURCE — `\` to two trailing spaces, or
 * back.
 *
 * Purpose: change how hard breaks are spelled in text this pipeline did not
 * serialize, without changing anything else about the document.
 *
 * Key decisions:
 *   - Only what the parser reads as a hard break is a candidate
 *     (hardBreakRanges.ts). A line pattern is used once, as a cheap "could
 *     there be one?" gate before parsing; it never authorizes an edit.
 *   - The result is VERIFIED against the document parse, and that alone is
 *     what makes a respelling safe: the edited text is returned only when it
 *     parses to exactly the tree the original does, positions aside. A `break`
 *     node records no spelling, so respelling breaks and nothing else leaves
 *     the tree identical; any other outcome means an edit changed something,
 *     and the text is returned exactly as written.
 *     Finding the breaks cannot give that guarantee. A break's bytes also take
 *     part in what surrounds them — in a paragraph whose first line is
 *     `| h |\`, spaces in place of the backslash make that line a table header
 *     and the paragraph a table. And the candidates come from a parse of the
 *     text as written, while the document parse first rewrites bare list
 *     markers, unclosed `$$` fences and `\[ \]` math, so a line the first
 *     reads as followed by paragraph text the second may read as a
 *     paragraph's last — where trailing spaces are no break, and a backslash
 *     in their place is a literal backslash added to the user's text.
 *   - Three respellings are known in advance to change the tree, and are not
 *     attempted: two spaces at the start of a line (a blank line), two spaces
 *     after a space or tab (the break swallows that whitespace; after a tab
 *     there is no break), and a backslash after an unpaired literal backslash
 *     (the two pair into one escaped backslash). Verification would refuse
 *     each of them — and with it every other edit to the document. Skipping
 *     them keeps one such line from switching normalization off for the whole
 *     document; `text \` is how many people write a break.
 *     hardBreakRespell.cost.test.ts pins this.
 *   - Verification is all or nothing. When it fails for a reason the three
 *     rules do not foresee, no smaller set of edits is searched for: each
 *     attempt is two more whole-document parses on the save path.
 *   - Text the parser cannot or should not be run over on a save — nested too
 *     deeply, or longer than HARD_BREAK_NORMALIZE_LIMIT — is returned exactly
 *     as written. Both spellings are valid markdown, so an unconverted break
 *     costs consistency, never content.
 *
 * @coordinates-with hardBreakRanges.ts — where the candidate hard breaks are
 * @coordinates-with parser.ts — the document parse the result is held to
 * @coordinates-with serializerBreak.ts — the same spelling rules on the serialize side
 * @coordinates-with utils/linebreaks.ts — the save-time entry point
 * @module utils/markdownPipeline/hardBreakRespell
 */

import { findHardBreakRanges, type HardBreakRange } from "./hardBreakRanges";
import { parseMarkdownToMdast } from "./parser";

type Spelling = HardBreakRange["spelling"];

/**
 * Length above which hard breaks are left as written.
 *
 * A save that respells breaks parses the whole document three times,
 * synchronously: once as written to find the breaks, and the document parse of
 * the text before and after to verify. Source mode keeps its buffer as typed,
 * so a document whose breaks need converting pays that on every save.
 *
 * CPU time on the test thread's own clock (node test tier, M-series Mac), for
 * plain prose and for a fixture with a break, a link, a `$$` block, a list and
 * a table every 250 bytes:
 *
 * | document | find, prose | verify, prose | find, dense | verify, dense |
 * |----------|-------------|---------------|-------------|---------------|
 * | 20 KB    | ~20 ms      | ~50 ms        | ~100 ms     | ~370 ms       |
 * | 100 KB   | ~125 ms     | ~270 ms       | ~430 ms     | ~1.6 s        |
 * | 150 KB   | ~195 ms     | ~390 ms       | ~570 ms     | ~2.3 s        |
 * | 300 KB   | ~365 ms     | ~790 ms       | ~1.1 s      | ~4.7 s        |
 *
 * The limit is set on the prose column, as the serializer's verified cosmetic
 * pass sets its own for the same kind of cost: about 0.6 s at the limit.
 * Markup-dense text costs several times more per byte, and a webview's engine
 * was not measured.
 */
export const HARD_BREAK_NORMALIZE_LIMIT = 150_000;

/** Length of the run of backslashes that ends just before `offset`. */
function backslashRunBefore(text: string, offset: number): number {
  let run = 0;
  while (offset - 1 - run >= 0 && text[offset - 1 - run] === "\\") run += 1;
  return run;
}

/**
 * Whether `text` (LF line endings) has a line that COULD be a hard break in
 * the spelling that is not `target`. A superset test, linear in the text.
 *
 * A backslash break ends its line with an ODD run of backslashes; an even run
 * is escaped backslashes, which is why a LaTeX row separator (two of them) is
 * not even a candidate. A two-space break ends its line with two or more
 * spaces.
 */
function mayHoldOtherSpelling(text: string, target: Spelling): boolean {
  for (let eol = text.indexOf("\n"); eol !== -1; eol = text.indexOf("\n", eol + 1)) {
    if (target === "twoSpaces") {
      if (backslashRunBefore(text, eol) % 2 === 1) return true;
    } else if (eol >= 2 && text[eol - 1] === " " && text[eol - 2] === " ") {
      return true;
    }
  }
  return false;
}

/**
 * The replacement for one hard break's own bytes (its line ending excluded),
 * or null when it is one of the respellings known to change the tree.
 */
function respelling(text: string, found: HardBreakRange, target: Spelling): string | null {
  if (found.spelling === target) return null;
  if (target === "twoSpaces") {
    if (found.startsLine) return null;
    const before = text[found.start - 1];
    return before === " " || before === "\t" ? null : "  ";
  }
  return backslashRunBefore(text, found.start) % 2 === 1 ? null : "\\";
}

/** The document parse of `markdown`, positions removed, as a comparable string. */
function documentTree(markdown: string): string {
  return JSON.stringify(parseMarkdownToMdast(markdown), (key, value: unknown) =>
    key === "position" ? undefined : value,
  );
}

/**
 * Hard breaks of `text` respelled as `target`, or `text` itself when nothing
 * can be changed safely. `text` is editor text: LF line endings, no BOM.
 */
export function respellHardBreaks(text: string, target: Spelling): string {
  if (!mayHoldOtherSpelling(text, target)) return text;
  if (text.length > HARD_BREAK_NORMALIZE_LIMIT) return text;

  const breaks = findHardBreakRanges(text);
  if (breaks === null) return text;

  let output = "";
  let cursor = 0;
  let edited = false;
  for (const found of breaks) {
    const replacement = respelling(text, found, target);
    if (replacement === null) continue;
    // The break's own bytes end where its line ending starts.
    output += text.slice(cursor, found.start) + replacement;
    cursor = found.end - 1;
    edited = true;
  }
  if (!edited) return text;
  output += text.slice(cursor);

  return documentTree(output) === documentTree(text) ? output : text;
}
