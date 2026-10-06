/**
 * Search match selection (WYSIWYG)
 *
 * Purpose: decide which match is current after a rescan, and draw the
 * decorations that show it. Every rescan used to report the FIRST match as
 * current: a Replace on a middle match jumped back to the top, a replacement
 * that contained the query became the next "current" match (so pressing
 * Replace again rewrote the text just inserted), and any edit made while the
 * find bar was open lost the user's place.
 *
 * Key decisions:
 *   - A query or option change starts at the first match: the user asked a
 *     new question.
 *   - Every other rescan keeps the place by POSITION — the first match that
 *     starts at or after an anchor. After an ordinary edit the anchor is where
 *     the current match was, mapped through the edit. After a Replace it is
 *     the END of the inserted text, carried on the replace transaction as
 *     `SEARCH_RESUME_AFTER_META`, so the replacement is never the next match.
 *   - With nothing at or after the anchor the selection wraps to the first
 *     match, as Next does.
 *
 * @coordinates-with tiptap.ts — calls these on every rebuild
 * @coordinates-with replaceActions.ts — sets the resume anchor on a Replace
 * @module plugins/search/matchSelection
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Match } from "./findMatches";

/** Transaction meta: the document position a Replace resumes after. */
export const SEARCH_RESUME_AFTER_META = "searchResumeAfter";

/**
 * The index of the first match starting at or after `anchor`, wrapping to the
 * first match; `-1` when there are none. A `null` anchor selects the first.
 * `matches` is in document order, as `findMatchesInDoc` returns it.
 */
export function indexAtOrAfter(matches: readonly Match[], anchor: number | null): number {
  if (matches.length === 0) return -1;
  if (anchor === null) return 0;
  const index = matches.findIndex((m) => m.from >= anchor);
  return index === -1 ? 0 : index;
}

/** Highlight every match, the current one as active; empty when hidden. */
export function matchDecorations(
  doc: ProseMirrorNode,
  matches: readonly Match[],
  currentIndex: number,
  visible: boolean,
): DecorationSet {
  if (!visible || matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((match, i) =>
      Decoration.inline(match.from, match.to, {
        class: i === currentIndex ? "search-match search-match-active" : "search-match",
      }),
    ),
  );
}
