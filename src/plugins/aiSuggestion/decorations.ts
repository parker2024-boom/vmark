/**
 * AI Suggestion Decorations
 *
 * Purpose: turn the pending suggestions into ProseMirror decorations, and keep
 * that decoration set as plugin state so it is built when the suggestions
 * change rather than on every transaction.
 *
 * Key decisions:
 *   - The set is rebuilt only when the registry hands over a different
 *     suggestions map or focused id (the registry replaces its map on every
 *     change). A document edit maps the existing set; a cursor move returns it
 *     untouched, so ProseMirror has nothing to compare.
 *   - A set rebuilt in the same transaction as a document edit is built
 *     against the document BEFORE the edit and then mapped: the registry's
 *     positions are remapped only after the transaction has been applied.
 *   - Every widget has a key made of everything it draws from: suggestion id,
 *     focus, content and range. ProseMirror keeps the DOM of a widget whose
 *     key is unchanged. The range is part of the key because the buttons act
 *     on the suggestion they were built with — a moved suggestion is redrawn.
 *   - Insert: ghost text widget at position. Replace: original struck through
 *     plus ghost text. Delete: original struck through. The document itself is
 *     never modified until the user accepts.
 *
 * @coordinates-with tiptap.ts — installs the state field and serves it as decorations
 * @coordinates-with widgets.ts — the DOM each widget renders
 * @module plugins/aiSuggestion/decorations
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isValidPosition } from "./applySuggestion";
import type { AiSuggestion, AiSuggestionStore } from "./types";
import { createButtons, createGhostText } from "./widgets";

/** The decoration set and the registry data it was built from. */
export interface SuggestionDecorationState {
  readonly decorations: DecorationSet;
  readonly suggestions: Map<string, AiSuggestion>;
  readonly focusedSuggestionId: string | null;
}

/**
 * Check if a DOM event targets a suggestion button.
 * Used by widget decorations to tell ProseMirror not to handle button clicks.
 * @exported for testing
 */
export function isButtonEvent(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return target.closest(".ai-suggestion-btn") !== null;
}

/**
 * Get decoration class for delete/replace original text.
 * @exported for testing
 */
export function getDecorationClass(suggestion: AiSuggestion, isFocused: boolean): string {
  const baseClass = `ai-suggestion ai-suggestion-${suggestion.type}`;
  return isFocused ? `${baseClass} ai-suggestion-focused` : baseClass;
}

/** Everything a suggestion's widget is drawn from; equal keys mean equal DOM. */
function widgetKey(kind: string, suggestion: AiSuggestion, isFocused: boolean): string {
  const { id, from, to, newContent = "" } = suggestion;
  return `ai-suggestion-${kind}:${id}:${isFocused ? "focused" : "idle"}:${from}-${to}:${newContent}`;
}

/** Strikethrough over the text a replace or delete suggestion would remove. */
function strikethrough(suggestion: AiSuggestion, isFocused: boolean): Decoration {
  return Decoration.inline(suggestion.from, suggestion.to, {
    class: getDecorationClass(suggestion, isFocused),
    "data-suggestion-id": suggestion.id,
    "data-suggestion-type": suggestion.type,
  });
}

/** Ghost text for the new content, with the buttons when the suggestion is focused. */
function ghostWidget(
  kind: "insert" | "replace",
  pos: number,
  suggestion: AiSuggestion,
  isFocused: boolean,
  store: AiSuggestionStore,
): Decoration {
  return Decoration.widget(
    pos,
    (view) => {
      const container = document.createElement("span");
      container.className = `ai-suggestion-${kind}-container`;
      container.setAttribute("data-suggestion-id", suggestion.id);
      if (suggestion.newContent) {
        container.appendChild(createGhostText(suggestion.newContent, isFocused));
      }
      if (isFocused) container.appendChild(createButtons(suggestion, view, store));
      return container;
    },
    { side: 0, stopEvent: isButtonEvent, key: widgetKey(kind, suggestion, isFocused) },
  );
}

/** The decorations of every pending suggestion whose range fits `doc`. */
function buildDecorations(doc: PMNode, store: AiSuggestionStore): SuggestionDecorationState {
  const { suggestions, focusedSuggestionId } = store.getState();
  const decorations: Decoration[] = [];
  const docSize = doc.content.size;

  for (const suggestion of suggestions.values()) {
    const isFocused = suggestion.id === focusedSuggestionId;
    // Skip suggestions with invalid positions
    if (!isValidPosition(suggestion, docSize)) continue;

    switch (suggestion.type) {
      case "insert":
        // No inline decoration - document unchanged
        decorations.push(ghostWidget("insert", suggestion.from, suggestion, isFocused, store));
        break;

      case "replace":
        // Skip zero-length range (nothing to strike through)
        if (suggestion.from === suggestion.to) continue;
        decorations.push(strikethrough(suggestion, isFocused));
        decorations.push(ghostWidget("replace", suggestion.to, suggestion, isFocused, store));
        break;

      case "delete":
        // Skip zero-length range (nothing to delete)
        if (suggestion.from === suggestion.to) continue;
        decorations.push(strikethrough(suggestion, isFocused));
        if (isFocused) {
          decorations.push(
            Decoration.widget(suggestion.to, (view) => createButtons(suggestion, view, store), {
              side: 0,
              stopEvent: isButtonEvent,
              key: widgetKey("delete", suggestion, isFocused),
            }),
          );
        }
        break;
    }
  }

  return {
    decorations: decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty,
    suggestions,
    focusedSuggestionId,
  };
}

/** The plugin's state field: build, map through edits, rebuild when the registry changes. */
export function suggestionDecorationField(store: AiSuggestionStore) {
  return {
    init: (_config: unknown, state: EditorState): SuggestionDecorationState => buildDecorations(state.doc, store),
    apply(tr: Transaction, value: SuggestionDecorationState, oldState: EditorState): SuggestionDecorationState {
      const { suggestions, focusedSuggestionId } = store.getState();
      const current =
        suggestions === value.suggestions && focusedSuggestionId === value.focusedSuggestionId
          ? value
          : buildDecorations(oldState.doc, store);
      if (!tr.docChanged) return current;
      return { ...current, decorations: current.decorations.map(tr.mapping, tr.doc) };
    },
  };
}
