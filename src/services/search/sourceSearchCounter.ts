/**
 * Source Search Counter
 *
 * Purpose: keep the find bar's counter — how many matches, which one is
 * current — true for the Source-mode editor. Every count comes from
 * CodeMirror's own search engine (`utils/sourceEditorSearch.ts`), and after an
 * ordinary edit the current match keeps its place by POSITION, the rule WYSIWYG
 * search applies (`plugins/search/matchSelection.ts`).
 *
 * Key decisions:
 *   - Each published count remembers its matches, and the update listener
 *     `sourceSearchPlace` carries them through every edit made since. The
 *     recount after an edit resumes at the first match starting at or after
 *     where the current match was. Keeping the index by NUMBER pointed the
 *     counter at a different match whenever a match was added or removed
 *     above it.
 *   - Remembered per view in a WeakMap, not in editor state: recording a
 *     count must not dispatch a transaction, which mid-composition breaks IME
 *     input.
 *   - A history the listener cannot follow (it did not see an update) forgets
 *     the place rather than mapping through the wrong edits; the next recount
 *     starts at the first match.
 *
 * @coordinates-with utils/sourceEditorSearch.ts — the query and the matches it finds
 * @coordinates-with hooks/useSourceEditorSearch.ts — counts on a query change and a Replace
 * @coordinates-with components/Editor/SourceEditor.tsx — counts after an edit
 * @module services/search/sourceSearchCounter
 */
import { ChangeSet, type Extension, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indexAtOrAfter } from "@/plugins/search/matchSelection";
import { useUIStore } from "@/stores/uiStore";
import { debounce } from "@/utils/debounce";
import {
  findSourceMatches,
  type SourceMatch,
  type SourceSearchParams,
} from "@/utils/sourceEditorSearch";

/** How long the counter waits for typing to pause before recounting. */
const RECOUNT_DEBOUNCE_MS = 300;

/** The matches a count published, and the edits made to the document since. */
interface Place {
  matches: readonly SourceMatch[];
  /** The document the edits in `changes` lead to. */
  doc: Text;
  changes: ChangeSet;
}

const places = new WeakMap<EditorView, Place>();

/** Carries the last count's matches through every edit. Install once per view. */
export const sourceSearchPlace: Extension = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  const place = places.get(update.view);
  if (!place) return;
  if (place.doc !== update.startState.doc) {
    places.delete(update.view);
    return;
  }
  places.set(update.view, {
    matches: place.matches,
    doc: update.state.doc,
    changes: place.changes.compose(update.changes),
  });
});

/**
 * Where match `index` of the last count starts in the document NOW, or null
 * when there is no such match or its history could not be followed. A match
 * that was deleted maps to where it was.
 */
export function sourceMatchPlace(view: EditorView, index: number): number | null {
  const place = places.get(view);
  const match = place?.matches[index];
  if (!place || !match || place.doc !== view.state.doc) return null;
  return place.changes.mapPos(match.from, 1);
}

/**
 * Count the matches of `search` with CodeMirror's engine, choose the current
 * one with `pick` (an index into the matches, -1 for none), and publish both
 * to the find bar. The matches are remembered for the next recount's place.
 */
export function publishSourceMatches(
  view: EditorView,
  search: SourceSearchParams,
  pick: (matches: readonly SourceMatch[]) => number,
): void {
  const matches = findSourceMatches(view.state, search);
  places.set(view, { matches, doc: view.state.doc, changes: ChangeSet.empty(view.state.doc.length) });
  useUIStore.getState().searchSetMatches(matches.length, pick(matches));
}

/** The recount after an ordinary edit, debounced so typing does not rescan per key. */
export interface SourceSearchRecount {
  /** Schedule a recount of `view` when the find bar has a query; restarts the wait. */
  schedule: (view: EditorView) => void;
  /** Drop a recount that has not run. */
  cancel: () => void;
}

/** Build the debounced recount for one editor. */
export function createSourceSearchRecount(): SourceSearchRecount {
  const recount = debounce((view: EditorView) => {
    // Read the find bar fresh: its query may have changed while waiting.
    const search = useUIStore.getState().search;
    if (!search.isOpen || !search.query) return;
    const place = sourceMatchPlace(view, search.currentIndex);
    publishSourceMatches(view, search, (matches) => indexAtOrAfter(matches, place));
  }, RECOUNT_DEBOUNCE_MS);

  return {
    schedule: (view) => {
      const { isOpen, query } = useUIStore.getState().search;
      if (isOpen && query) recount(view);
    },
    cancel: () => recount.cancel(),
  };
}
