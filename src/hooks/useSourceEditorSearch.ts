/**
 * Source Editor Search Hook
 *
 * Purpose: Bridges the search store to CodeMirror's search extension —
 *   subscribes to search state changes and dispatches find/replace/count
 *   operations to the CodeMirror editor view.
 *
 * Key decisions:
 *   - After a Replace the counter follows the match CodeMirror selected: the
 *     first match at or after the end of the inserted text, wrapping to the
 *     first (the WYSIWYG rule). Keeping the old index pointed the counter at
 *     the inserted text whenever the replacement contained the query.
 *   - That counter move is not navigation: the subscriber ignores it, or it
 *     would run Next/Previous and pull the selection off the match.
 *   - Every count is CodeMirror's own (services/search/sourceSearchCounter.ts),
 *     made with the same query the editor searches with, so the counter
 *     describes exactly the matches Next and Previous step through.
 *
 * @coordinates-with stores/uiStore/searchSlice.ts — reads query, caseSensitive, regex flags
 * @coordinates-with utils/sourceEditorSearch.ts — the one query construction
 * @coordinates-with services/search/sourceSearchCounter.ts — counts and publishes
 * @coordinates-with plugins/search/matchSelection.ts — the shared resume rule (indexAtOrAfter)
 * @module hooks/useSourceEditorSearch
 */
import { useEffect, type MutableRefObject } from "react";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from "@codemirror/search";
import { indexAtOrAfter } from "@/plugins/search/matchSelection";
import { useUIStore } from "@/stores/uiStore";
import { runOrQueueCodeMirrorAction } from "@/utils/imeGuard";
import { buildSourceSearchQuery, type SourceSearchParams } from "@/utils/sourceEditorSearch";
import { publishSourceMatches } from "@/services/search/sourceSearchCounter";

/** The search-slice fields this hook reads. */
type SearchState = SourceSearchParams & { matchCount: number; currentIndex: number };

/**
 * Recount, keeping the current index while it is still in range, else the
 * first match. A query or option change has already reset the index, so
 * after one this starts at the first match.
 */
function recomputeMatches(view: EditorView, state: SearchState): void {
  publishSourceMatches(view, state, (matches) => {
    if (matches.length === 0) return -1;
    return state.currentIndex >= 0 && state.currentIndex < matches.length ? state.currentIndex : 0;
  });
}

/**
 * Where the counter resumes after `replaceNext` turned `before` into `after`:
 * the END of the inserted text when a match was replaced, so a replacement
 * that contains the query is never the next match; the selection when
 * nothing was replaced (Replace only moved to the next match).
 */
function replaceResumeAnchor(before: EditorState, after: EditorState): number {
  if (after.doc === before.doc) return after.selection.main.from;
  return before.selection.main.to + (after.doc.length - before.doc.length);
}

/**
 * Recount after a Replace and point the counter at the first match starting
 * at or after `anchor`, wrapping to the first — the rule WYSIWYG search
 * applies (plugins/search/matchSelection.ts), and where CodeMirror's
 * `replaceNext` puts the selection.
 */
function recomputeAfterReplace(view: EditorView, state: SearchState, anchor: number): void {
  publishSourceMatches(view, state, (matches) => indexAtOrAfter(matches, anchor));
}

/**
 * Subscribe to the uiStore search slice and manage CodeMirror search operations.
 */
export function useSourceEditorSearch(
  viewRef: MutableRefObject<EditorView | null>
): void {
  useEffect(() => {
    let isInitialized = false;
    // True while a Replace moves the counter to the match CodeMirror already
    // selected. The index change must not be read as Next/Previous, which
    // would move the selection away from that match.
    let syncingCounterToSelection = false;

    // Initialize search state when view becomes available
    const initSearchState = (): boolean => {
      const view = viewRef.current;
      if (!view) return false;

      const state = useUIStore.getState().search;
      if (state.isOpen && state.query) {
        recomputeMatches(view, state);
        const query = buildSourceSearchQuery(state);
        runOrQueueCodeMirrorAction(view, () => {
          view.dispatch({ effects: setSearchQuery.of(query) });
        });
      }
      return true;
    };

    // Try immediate initialization, fall back to polling if view not ready.
    // Both timer IDs stored in an object so cleanup closures can always find them.
    const initTimers = {
      interval: null as ReturnType<typeof setInterval> | null,
      timeout: null as ReturnType<typeof setTimeout> | null,
    };

    if (!initSearchState()) {
      initTimers.interval = setInterval(() => {
        if (initSearchState()) {
          isInitialized = true;
          clearInterval(initTimers.interval!);
          initTimers.interval = null;
        }
      }, 50);

      // Safety: clear interval after max wait time
      initTimers.timeout = setTimeout(() => {
        initTimers.timeout = null;
        if (!isInitialized && initTimers.interval !== null) {
          clearInterval(initTimers.interval);
          initTimers.interval = null;
        }
      }, 500);
    } else {
      isInitialized = true;
    }

    const unsubscribe = useUIStore.subscribe((root, prevRoot) => {
      const view = viewRef.current;
      if (!view) return;
      const state = root.search;
      const prevState = prevRoot.search;

      // Update search query when search params change
      if (
        state.query !== prevState.query ||
        state.caseSensitive !== prevState.caseSensitive ||
        state.wholeWord !== prevState.wholeWord ||
        state.useRegex !== prevState.useRegex
      ) {
        if (state.query) {
          const query = buildSourceSearchQuery(state);
          runOrQueueCodeMirrorAction(view, () => {
            view.dispatch({ effects: setSearchQuery.of(query) });
          });
          recomputeMatches(view, state);
        } else {
          // Clear search
          runOrQueueCodeMirrorAction(view, () => {
            view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
          });
          useUIStore.getState().searchSetMatches(0, -1);
        }
      }

      // Handle find next/previous. The store WRAPS on navigation (last → 0 on
      // next, 0 → last on previous), so a raw index comparison inverts at
      // every wrap: forward iff the new index is the successor of the old one
      // modulo matchCount. At matchCount 2 successor and predecessor coincide,
      // so either user action resolves to findNext — which lands on the same
      // (only other) match findPrevious would.
      if (
        !syncingCounterToSelection &&
        state.currentIndex !== prevState.currentIndex &&
        state.currentIndex >= 0
      ) {
        const forward =
          state.matchCount > 0 &&
          state.currentIndex === (prevState.currentIndex + 1) % state.matchCount;
        if (forward) {
          runOrQueueCodeMirrorAction(view, () => findNext(view));
        } else {
          runOrQueueCodeMirrorAction(view, () => findPrevious(view));
        }
      }

      // Handle replace text changes - always include in query to keep it fresh
      if (state.replaceText !== prevState.replaceText && state.isOpen && state.query) {
        const query = buildSourceSearchQuery(state);
        runOrQueueCodeMirrorAction(view, () => {
          view.dispatch({ effects: setSearchQuery.of(query) });
        });
      }
    });

    // Handle replace actions via custom events
    const handleReplaceCurrent = (): void => {
      const view = viewRef.current;
      if (!view) return;

      runOrQueueCodeMirrorAction(view, () => {
        const before = view.state;
        replaceNext(view);
        const anchor = replaceResumeAnchor(before, view.state);
        // Update match count after replace - double rAF for state to settle
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const current = viewRef.current;
            if (!current) return;
            syncingCounterToSelection = true;
            try {
              recomputeAfterReplace(current, useUIStore.getState().search, anchor);
            } finally {
              syncingCounterToSelection = false;
            }
          });
        });
      });
    };

    const handleReplaceAll = (): void => {
      const view = viewRef.current;
      if (!view) return;

      runOrQueueCodeMirrorAction(view, () => replaceAll(view));
      // Update match count after replace all - double rAF for state to settle
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const state = useUIStore.getState().search;
          if (viewRef.current) {
            recomputeMatches(viewRef.current, state);
          }
        });
      });
    };

    window.addEventListener("search:replace-current", handleReplaceCurrent);
    window.addEventListener("search:replace-all", handleReplaceAll);

    return () => {
      if (initTimers.interval !== null) clearInterval(initTimers.interval);
      if (initTimers.timeout !== null) clearTimeout(initTimers.timeout);
      unsubscribe();
      window.removeEventListener("search:replace-current", handleReplaceCurrent);
      window.removeEventListener("search:replace-all", handleReplaceAll);
    };
  }, [viewRef]);
}
