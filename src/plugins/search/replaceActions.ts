/**
 * Search Replace Actions (WYSIWYG)
 *
 * Purpose: Replace Current / Replace All handlers for the search plugin.
 *
 * Key decisions:
 *   - Transactions are constructed INSIDE the IME-guard callback against the
 *     view's CURRENT state: an action queued during composition would
 *     otherwise dispatch a transaction built from a stale state and throw
 *     "mismatched transaction".
 *   - Targets are re-validated with a fresh findMatchesInDoc scan at
 *     execution time: within the 200ms doc-change debounce the plugin's
 *     match list holds mapped POSITIONS whose text may no longer match the
 *     query. Replace Current skips a range that is no longer a live match;
 *     Replace All simply operates on the fresh scan, in one transaction, so
 *     it never re-matches the text it inserts.
 *   - Replace Current does not step the index itself. It marks its
 *     transaction with where the inserted text ends; the plugin rescans and
 *     makes the first match after that point current. Stepping with
 *     `findNext` raced the plugin's own rescan, which then reset the index to
 *     the first match — often the text just inserted.
 *
 * @coordinates-with tiptap.ts — wires these handlers to the search:replace-* events
 * @coordinates-with matchSelection.ts — the resume anchor a Replace sets
 * @coordinates-with findMatches.ts — fresh scan used for re-validation
 * @module plugins/search/replaceActions
 */

import { hostSearch } from "@/plugins/shared/hostSearch";
import type { EditorView } from "@tiptap/pm/view";
import { runOrQueueProseMirrorAction } from "@/utils/imeGuard";
import { findMatchesInDoc, type Match } from "./findMatches";
import { SEARCH_RESUME_AFTER_META } from "./matchSelection";

function scanCurrentDoc(view: EditorView): Match[] {
  const { query, caseSensitive, wholeWord, useRegex } = hostSearch.current();
  return findMatchesInDoc(view.state.doc, query, caseSensitive, wholeWord, useRegex);
}

/** The slice of the plugin's state the replace handlers read. */
export interface SearchPluginMatches {
  matches: Match[];
  currentIndex: number;
}

/**
 * Build the Replace Current / Replace All handlers for a view.
 * `getState` reads the plugin state's (possibly mapped) match list and current
 * index at execution time — needed to resolve which range `currentIndex`
 * points at, and where a Replace left it.
 */
export function createReplaceHandlers(
  editorView: EditorView,
  getState: () => SearchPluginMatches | undefined,
) {
  const replaceCurrent = () => {
    if (editorView.editable === false) return;
    const { isOpen, currentIndex } = hostSearch.current();
    if (!isOpen || currentIndex < 0) return;

    runOrQueueProseMirrorAction(editorView, () => {
      if (editorView.isDestroyed) return;
      const search = hostSearch.current();
      if (!search.isOpen || search.currentIndex < 0) return;

      const match = getState()?.matches[search.currentIndex];
      if (!match) return;

      // Re-validate: mapped positions survive edits, but the text underneath
      // may have changed. Only replace when this exact range is still a live
      // match for the current query.
      const fresh = scanCurrentDoc(editorView);
      if (!fresh.some((m) => m.from === match.from && m.to === match.to)) return;

      const tr = editorView.state.tr.replaceWith(
        match.from,
        match.to,
        search.replaceText ? editorView.state.schema.text(search.replaceText) : [],
      );
      // The next match is the first one AFTER the inserted text: the plugin
      // rescans on this transaction and resumes there, so a replacement that
      // contains the query is never the next target.
      tr.setMeta(SEARCH_RESUME_AFTER_META, tr.mapping.map(match.to));
      editorView.dispatch(tr);

      // Report the new place now rather than on the rescan's microtask: a
      // Replace queued behind this one (IME composition flushes them in one
      // go) must read the index this one left, not the one it replaced.
      const after = getState();
      if (after) hostSearch.reportMatches(after.matches.length, after.currentIndex);
    });
  };

  const replaceAll = () => {
    if (editorView.editable === false) return;
    const { isOpen, query } = hostSearch.current();
    if (!isOpen || !query) return;

    runOrQueueProseMirrorAction(editorView, () => {
      if (editorView.isDestroyed) return;
      const search = hostSearch.current();
      if (!search.isOpen || !search.query) return;

      // Fresh scan at execution time — the plugin's mapped list can be stale
      // within the debounce window (and misses matches created by the edit).
      const fresh = scanCurrentDoc(editorView);
      if (fresh.length === 0) return;

      // Reverse order so earlier positions stay valid while replacing.
      const sorted = [...fresh].sort((a, b) => b.from - a.from);
      let tr = editorView.state.tr;
      for (const match of sorted) {
        tr = tr.replaceWith(
          match.from,
          match.to,
          search.replaceText ? editorView.state.schema.text(search.replaceText) : [],
        );
      }
      editorView.dispatch(tr);
    });
  };

  return { replaceCurrent, replaceAll };
}
