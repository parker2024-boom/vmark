/**
 * Source Editor Search
 *
 * Purpose: the one construction of the Source-mode search query, and the
 * matches it finds. Both come from CodeMirror's own search engine — the engine
 * Next, Previous and Replace use — so the find bar's counter counts exactly
 * the matches those commands step through.
 *
 * Key decisions:
 *   - No second regex. A hand-built `RegExp` counted differently from the
 *     engine: without the multiline flag `^` and `$` matched only at the ends
 *     of the document, Whole Word was ignored in regex mode, and a typed `\n`
 *     was taken literally where the engine reads it as a line break.
 *   - Zero-length regex matches are counted as the engine's cursor yields them.
 *   - An empty or invalid query finds nothing rather than throwing.
 *
 * @coordinates-with hooks/useSourceEditorSearch.ts — hands the query to CodeMirror
 * @coordinates-with services/search/sourceSearchCounter.ts — counts with it
 * @module utils/sourceEditorSearch
 */
import type { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

/** The find bar's settings, as the search slice holds them. */
export interface SourceSearchParams {
  query: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

/** One match, as document positions. */
export interface SourceMatch {
  from: number;
  to: number;
}

/**
 * The CodeMirror query for the find bar's settings. It always carries the
 * replacement text, so a Replace never runs with a stale one.
 */
export function buildSourceSearchQuery(params: SourceSearchParams): SearchQuery {
  return new SearchQuery({
    search: params.query,
    replace: params.replaceText,
    caseSensitive: params.caseSensitive,
    wholeWord: params.wholeWord,
    regexp: params.useRegex,
  });
}

/** Every match of the find bar's query in `state`, in document order. */
export function findSourceMatches(state: EditorState, params: SourceSearchParams): SourceMatch[] {
  if (!params.query) return [];
  const query = buildSourceSearchQuery(params);
  if (!query.valid) return [];
  const matches: SourceMatch[] = [];
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    matches.push({ from: next.value.from, to: next.value.to });
  }
  return matches;
}
