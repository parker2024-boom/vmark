/**
 * AI Suggestion Tiptap Extension
 *
 * Purpose: Renders AI-generated suggestions as non-destructive decorations (ghost text,
 * strikethrough) and commits document changes only when the user explicitly accepts.
 *
 * Pipeline: AI provider → the host's suggestion registry → this plugin reads it
 *         through its PORT → decorations → accept/reject applies or discards
 *
 * Key decisions:
 *   - UNDO/REDO SAFE: Document is NOT modified until user accepts — all previews are decorations
 *   - POSITION SAFE: stored from/to are remapped through every doc-changing
 *     transaction (onTransaction → computeSuggestionRemap); suggestions whose
 *     target text is edited directly are dismissed as stale
 *   - The decoration set is plugin state (decorations.ts): rebuilt when the
 *     suggestions change, mapped through edits, and its widgets are keyed
 *   - Accept/reject buttons are ProseMirror widgets, acting on the view they are handed
 *
 * @coordinates-with types.ts — AiSuggestion interface and event name constants
 * @coordinates-with types.ts — the AiSuggestionStore PORT; widgets.ts — its DOM
 * @coordinates-with decorations.ts — which decorations exist, and when they are rebuilt
 * @coordinates-with utils/settledScroll.ts — scrolls to the focused suggestion
 * @module plugins/aiSuggestion/tiptap
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { hostDocument } from "@/plugins/shared/hostDocument";
import {
  requireSuggestionStore,
  type AiSuggestionOptions,
} from "./types";
import { runOrQueueProseMirrorAction } from "@/utils/imeGuard";
import type { AiSuggestion } from "./types";
import { AI_SUGGESTION_EVENTS } from "./types";
import { captureAcceptedSuggestion } from "./widgets";
import { suggestionDecorationField, type SuggestionDecorationState } from "./decorations";
import "./ai-suggestion.css";

const aiSuggestionPluginKey = new PluginKey<SuggestionDecorationState>("aiSuggestion");

export { applySuggestionToTr, computeSuggestionRemap, isValidPosition } from "./applySuggestion";
export { getDecorationClass, isButtonEvent } from "./decorations";
import { applySuggestionToTr, computeSuggestionRemap, isValidPosition } from "./applySuggestion";
import { scrollToSettled } from "@/utils/settledScroll";

/** Tiptap extension that renders AI suggestion decorations and handles accept/reject shortcuts. */
export const aiSuggestionExtension = Extension.create<AiSuggestionOptions>({
  name: "aiSuggestion",

  addOptions() {
    return { store: null };
  },

  // Remap pending suggestion positions through every document change so
  // decorations and accept always target the intended text.
  onTransaction({ transaction }) {
    if (!transaction.docChanged) return;
    const store = requireSuggestionStore(this.options.store).getState();
    if (store.suggestions.size === 0) return;
    store.updateSuggestionRanges(
      computeSuggestionRemap(store.suggestions.values(), transaction.mapping)
    );
  },

  addKeyboardShortcuts() {
    return {
      // Enter: accept focused suggestion
      Enter: () => {
        const state = requireSuggestionStore(this.options.store).getState();
        if (state.focusedSuggestionId && state.suggestions.size > 0) {
          state.acceptSuggestion(state.focusedSuggestionId);
          return true;
        }
        return false;
      },

      // Escape: reject focused suggestion
      Escape: () => {
        const state = requireSuggestionStore(this.options.store).getState();
        if (state.focusedSuggestionId && state.suggestions.size > 0) {
          state.rejectSuggestion(state.focusedSuggestionId);
          return true;
        }
        return false;
      },

      // Tab: navigate to next suggestion
      Tab: () => {
        const state = requireSuggestionStore(this.options.store).getState();
        if (state.suggestions.size > 0) {
          state.navigateNext();
          return true;
        }
        return false;
      },

      // Shift-Tab: navigate to previous suggestion
      "Shift-Tab": () => {
        const state = requireSuggestionStore(this.options.store).getState();
        /* v8 ignore start -- @preserve else branch: no suggestions to navigate */
        if (state.suggestions.size > 0) {
          state.navigatePrevious();
          return true;
        }
        return false;
        /* v8 ignore stop */
      },

      // Mod-Shift-Enter: accept all suggestions
      "Mod-Shift-Enter": () => {
        const state = requireSuggestionStore(this.options.store).getState();
        if (state.suggestions.size > 0) {
          state.acceptAll();
          return true;
        }
        return false;
      },

      // Mod-Shift-Escape: reject all suggestions
      "Mod-Shift-Escape": () => {
        const state = requireSuggestionStore(this.options.store).getState();
        if (state.suggestions.size > 0) {
          state.rejectAll();
          return true;
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const store = requireSuggestionStore(this.options.store);

    return [
      new Plugin({
        key: aiSuggestionPluginKey,

        // Built when the suggestions change, mapped through edits, untouched
        // by everything else — see decorations.ts.
        state: suggestionDecorationField(store),

        props: {
          decorations(state) {
            return aiSuggestionPluginKey.getState(state)?.decorations;
          },

          handleClick(_view, _pos, event) {
            // Focus suggestion when clicked
            const target = event.target as HTMLElement;
            const suggestionEl = target.closest("[data-suggestion-id]");
            if (suggestionEl) {
              const id = suggestionEl.getAttribute("data-suggestion-id");
              /* v8 ignore next -- @preserve else branch: data-suggestion-id attribute exists but value is null */
              if (id) {
                store.getState().focusSuggestion(id);
                return true;
              }
            }
            return false;
          },
        },

        view(editorView) {
          // Handle accept event — apply the suggestion's document change
          const handleAccept = (event: Event) => {
            const { suggestion } = (event as CustomEvent).detail as {
              suggestion: AiSuggestion;
            };

            runOrQueueProseMirrorAction(editorView, () => {
              const bufferWasDirty = hostDocument.isTabDirty(suggestion.tabId);
              const { state } = editorView;
              editorView.dispatch(applySuggestionToTr(state, state.tr, suggestion));
              captureAcceptedSuggestion(suggestion.tabId, bufferWasDirty);
            });
          };

          // Trigger decoration refresh via empty transaction
          const refreshDecorations = () => {
            runOrQueueProseMirrorAction(editorView, () => {
              editorView.dispatch(editorView.state.tr);
            });
          };

          // Handle reject event — just refresh decorations (no doc changes)
          const handleReject = refreshDecorations;

          // Handle accept all event — apply all changes in a SINGLE transaction
          const handleAcceptAll = (event: Event) => {
            const { suggestions } = (event as CustomEvent).detail as {
              suggestions: AiSuggestion[];
            };

            if (suggestions.length === 0) return;

            runOrQueueProseMirrorAction(editorView, () => {
              const tabId = suggestions[0].tabId;
              const bufferWasDirty = hostDocument.isTabDirty(tabId);
              const { state } = editorView;
              let { tr } = state;

              // Apply all suggestions in reverse order (they're already sorted reverse)
              // so earlier positions remain valid as we modify later ones
              for (const suggestion of suggestions) {
                tr = applySuggestionToTr(state, tr, suggestion);
              }

              editorView.dispatch(tr);
              captureAcceptedSuggestion(tabId, bufferWasDirty);
            });
          };

          // Handle reject all event — just refresh decorations
          const handleRejectAll = refreshDecorations;

          // Handle store changes to trigger decoration updates
          const unsubscribe = store.subscribe(refreshDecorations);

          // Subscribe to scroll-to-focus events
          const handleFocusChanged = (event: Event) => {
            const { id } = (event as CustomEvent).detail;
            const suggestion = store.getState().getSuggestion(id);
            if (!suggestion) return;

            // Guard against stale positions after doc changes
            if (!isValidPosition(suggestion, editorView.state.doc.content.size)) return;

            // Scroll the editor's scroll container — .ProseMirror never scrolls —
            // settled, as content-visibility moves a far target mid-scroll (#1458)
            const scroller = editorView.dom.closest<HTMLElement>(".editor-content");
            if (!scroller) return;
            const coords = editorView.coordsAtPos(suggestion.from);
            const rect = scroller.getBoundingClientRect();
            if (coords.top < rect.top || coords.bottom > rect.bottom) {
              scrollToSettled(scroller, () => (isValidPosition(suggestion, editorView.state.doc.content.size)
                ? editorView.coordsAtPos(suggestion.from).top - scroller.getBoundingClientRect().top - rect.height / 3
                : null), editorView.dom);
            }
          };

          window.addEventListener(AI_SUGGESTION_EVENTS.ACCEPT, handleAccept);
          window.addEventListener(AI_SUGGESTION_EVENTS.REJECT, handleReject);
          window.addEventListener(AI_SUGGESTION_EVENTS.ACCEPT_ALL, handleAcceptAll);
          window.addEventListener(AI_SUGGESTION_EVENTS.REJECT_ALL, handleRejectAll);
          window.addEventListener(AI_SUGGESTION_EVENTS.FOCUS_CHANGED, handleFocusChanged);

          return {
            destroy() {
              unsubscribe();
              window.removeEventListener(AI_SUGGESTION_EVENTS.ACCEPT, handleAccept);
              window.removeEventListener(AI_SUGGESTION_EVENTS.REJECT, handleReject);
              window.removeEventListener(AI_SUGGESTION_EVENTS.ACCEPT_ALL, handleAcceptAll);
              window.removeEventListener(AI_SUGGESTION_EVENTS.REJECT_ALL, handleRejectAll);
              window.removeEventListener(AI_SUGGESTION_EVENTS.FOCUS_CHANGED, handleFocusChanged);
            },
          };
        },
      }),
    ];
  },
});
