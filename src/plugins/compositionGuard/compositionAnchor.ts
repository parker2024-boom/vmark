/**
 * Composition Anchor
 *
 * Purpose: remember where an IME composition began, as a position that stays
 * true while the document changes underneath it.
 *
 * The guard needs that position after the composition ends, to find leftover
 * preedit text and to tell whether the composition is inside a heading. It
 * used to keep the raw number it read at `compositionstart`. Any transaction
 * that was not the composition itself — an AI client's edit, a content sync —
 * moved the text under that number, and the cleanup then deleted whatever lay
 * between the stale position and the composed text.
 *
 * Key decisions:
 *   - A position belongs to a DOCUMENT, so the anchor is kept per document: a
 *     table from each document a transaction produced to the anchor's place
 *     in it. Asking for the anchor in a document the composition never
 *     reached answers null rather than a number that means something else
 *     there. The table is weak; documents nobody holds take their entries
 *     with them.
 *   - No transaction is dispatched to start tracking. Every transaction
 *     recomputes decorations and can redraw, and WebKit's composition is
 *     sensitive to changes in the DOM around it; the start is recorded
 *     beside the document it was read from instead.
 *   - How the anchor moves depends on who wrote the transaction:
 *       · The composition itself (ProseMirror tags its input) inserts AT the
 *         anchor, so the anchor stays in front of that text. When WebKit
 *         rebuilds the whole block around a composition, the anchor keeps its
 *         offset inside the rebuilt block — the composition is still there.
 *       · A programmatic write (a content load, or an edit a tool placed in
 *         the undo history) that inserts at the anchor is someone else's
 *         text: the anchor moves behind it. If it replaces the text on both
 *         sides of the anchor there is no composition left to describe, and
 *         the anchor is RETIRED for that document and everything derived
 *         from it.
 *       · A transaction carrying neither marker is followed like typing, but
 *         one that replaces the text around the anchor retires it: the guard
 *         does nothing rather than act on a guess.
 *
 * Known limitations:
 *   - An unmarked write that inserts exactly at the anchor is taken for the
 *     composition's own text. Writers that are not the user's typing mark
 *     their transactions (`preventUpdate`, an explicit `addToHistory`), and
 *     should not write mid-composition at all — see services/ime.
 *
 * @coordinates-with plugins/compositionGuard/tiptap.ts — the only consumer
 * @module plugins/compositionGuard/compositionAnchor
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { Mapping } from "@tiptap/pm/transform";

/** One composition, from `compositionstart` until it is forgotten. */
interface Session {
  /** The document the start position was read from. */
  doc: PMNode;
  /** The start position in `doc`. */
  pos: number;
  /** The anchor in each document a followed transaction produced; null = retired. */
  moved: WeakMap<PMNode, number | null>;
}

/** Tracks one editor's composition anchor. */
export interface CompositionAnchor {
  /** Start tracking a composition that began at `pos` in `doc`. */
  begin(doc: PMNode, pos: number): void;
  /** Forget the composition. */
  end(): void;
  /**
   * An identity for the composition being tracked, or null when there is none.
   * Lets a deferred callback tell whether it still belongs to the current one.
   */
  current(): object | null;
  /** Record where the anchor lands in the document `tr` produces. */
  follow(tr: Transaction): void;
  /**
   * The anchor as a position in `doc`: null when no composition is tracked,
   * when `doc` is not a document the composition reached, or when the anchor
   * was retired on the way there.
   */
  at(doc: PMNode): number | null;
}

/**
 * True for a transaction written by something other than the user's typing: a
 * content load, or an edit a tool placed in the undo history explicitly. DOM
 * input never sets either marker.
 */
function isProgrammaticWrite(tr: Transaction): boolean {
  return tr.getMeta("preventUpdate") === true || tr.getMeta("addToHistory") !== undefined;
}

/** True for a transaction ProseMirror produced from the composition's own input. */
function isCompositionInput(tr: Transaction): boolean {
  const uiEvent = tr.getMeta("uiEvent");
  return Boolean(tr.getMeta("composition")) || uiEvent === "input" || uiEvent === "composition";
}

/**
 * Map `pos` through the composition's own change. A range rewritten AROUND the
 * position keeps the position's offset inside it, clamped to the new content;
 * anything else maps normally, staying in front of text inserted at it.
 */
function mapThroughOwnInput(mapping: Mapping, pos: number): number {
  let current = pos;
  for (const map of mapping.maps) {
    // A step's changed ranges do not overlap, so at most one contains `current`.
    const rewritten: number[] = [];
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (oldStart < current && current < oldEnd) {
        rewritten.push(Math.min(newStart + (current - oldStart), newEnd));
      }
    });
    current = rewritten.length > 0 ? rewritten[0]! : map.map(current, -1);
  }
  return current;
}

/** Where `pos` lands after `tr`, or null when the anchor is retired by it. */
function mapAnchor(tr: Transaction, pos: number): number | null {
  const programmatic = isProgrammaticWrite(tr);
  if (!programmatic && isCompositionInput(tr)) return mapThroughOwnInput(tr.mapping, pos);
  const mapped = tr.mapping.mapResult(pos, programmatic ? 1 : -1);
  return mapped.deletedAcross ? null : mapped.pos;
}

/** Create the anchor tracker for one editor. */
export function createCompositionAnchor(): CompositionAnchor {
  let session: Session | null = null;

  const at = (doc: PMNode): number | null => {
    if (!session) return null;
    const moved = session.moved.get(doc);
    if (moved !== undefined) return moved;
    return doc === session.doc ? session.pos : null;
  };

  return {
    begin(doc, pos) {
      session = { doc, pos, moved: new WeakMap() };
    },
    end() {
      session = null;
    },
    current() {
      return session;
    },
    follow(tr) {
      if (!session || !tr.docChanged) return;
      // A document this composition never reached: nothing to carry forward.
      if (tr.before !== session.doc && !session.moved.has(tr.before)) return;
      const pos = at(tr.before);
      session.moved.set(tr.doc, pos === null ? null : mapAnchor(tr, pos));
    },
    at,
  };
}
