/**
 * Footnote Cleanup On Edit
 *
 * Purpose: the footnote plugin's `appendTransaction` — when an edit removes a
 * footnote reference, delete the definitions left without one and renumber the
 * rest, in the same undo step.
 *
 * Pipeline: batch of transactions → could it have removed a reference? → if so,
 * collect footnotes of the old and new document → compare per-label counts →
 * cleanup/renumber transaction (tiptapCleanup.ts).
 *
 * Key decisions:
 *   - It runs on every transaction, so the common edit must not read the
 *     document. A reference count can only drop if a step removed or replaced
 *     a range holding a reference, or changed a node in place; a typed
 *     character does neither, and is recognized from the step alone.
 *   - A deletion is checked against the document the step was applied to:
 *     inside one parent only that parent's children are read.
 *   - Footnote collections are cached per document node. Documents are
 *     immutable, so the "old" document of one call is the "new" one of the
 *     call before, and is not walked twice.
 *   - A document known to hold no footnotes is rescanned only when an inserted
 *     slice carries one.
 *   - Skips IME composition (a mid-composition dispatch disrupts CJK input) and
 *     defers the cleanup to the next ordinary transaction; skips undo/redo
 *     batches (plugins/shared/historyBatch).
 *
 * @coordinates-with tiptap.ts — installs this as the plugin's appendTransaction
 * @coordinates-with tiptapCleanup.ts — collection, renumbering and orphan cleanup
 * @module plugins/footnotePopup/cleanupOnEdit
 */

import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode, NodeType, Slice } from "@tiptap/pm/model";
import { AddMarkStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { isHistoryBatch } from "@/plugins/shared/historyBatch";
import {
  collectFootnoteNodes,
  createCleanupAndRenumberTransaction,
  createRenumberTransaction,
  hasRefCountDropped,
} from "./tiptapCleanup";

type FootnoteNodes = ReturnType<typeof collectFootnoteNodes>;

/** Footnotes of a document, collected once per document node. */
const collectedByDoc = new WeakMap<PMNode, FootnoteNodes>();

function footnotesOf(doc: PMNode): FootnoteNodes {
  let collected = collectedByDoc.get(doc);
  if (!collected) {
    collected = collectFootnoteNodes(doc);
    collectedByDoc.set(doc, collected);
  }
  return collected;
}

/** Whether any inserted slice of the batch carries a footnote reference or definition. */
function transactionsInsertFootnote(
  transactions: readonly Transaction[],
  refType: NodeType,
  defType: NodeType,
): boolean {
  for (const tr of transactions) {
    for (const step of tr.steps) {
      // ReplaceStep/ReplaceAroundStep expose `slice`; other step types don't.
      const slice = (step as { slice?: Slice }).slice;
      if (!slice) continue;
      let found = false;
      slice.content.descendants((node) => {
        if (node.type === refType || node.type === defType) {
          found = true;
          return false;
        }
        return true;
      });
      if (found) return true;
    }
  }
  return false;
}

/** Whether `doc` holds a footnote reference between `from` and `to`. */
function rangeHoldsReference(doc: PMNode, from: number, to: number, refType: NodeType): boolean {
  if (from === to) return false;
  let found = false;
  const look = (node: PMNode) => {
    if (node.type === refType) found = true;
    return !found;
  };
  // Both positions were resolved when the step was applied, so these are
  // cached; a range inside one parent then reads that parent's children only.
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.sameParent($to)) $from.parent.nodesBetween($from.parentOffset, $to.parentOffset, look);
  else doc.nodesBetween(from, to, look);
  return found;
}

/**
 * Whether the batch could have lowered some label's reference count. True
 * unless every step is one that cannot: a mark change, or a replace whose
 * replaced range held no reference. A step of any other kind (an attribute
 * change may relabel a reference) is taken to be able to.
 */
function transactionsMayRemoveReference(transactions: readonly Transaction[], refType: NodeType): boolean {
  for (const tr of transactions) {
    for (let i = 0; i < tr.steps.length; i += 1) {
      const step = tr.steps[i];
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) continue;
      if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return true;
      if (rangeHoldsReference(tr.docs[i], step.from, step.to, refType)) return true;
    }
  }
  return false;
}

/**
 * Create the `appendTransaction` of one footnote plugin instance. The returned
 * function carries that editor's state between calls.
 */
export function createFootnoteCleanupOnEdit(): (
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
) => Transaction | null {
  // Track whether cleanup was deferred during IME composition.
  // If a composition transaction deletes a footnote ref, the cleanup
  // can't run mid-composition (would disrupt CJK input), so we mark
  // it pending and run on the first non-composition doc change.
  let cleanupPending = false;
  // Result of the last full "has footnotes" scan. null = not known. While it
  // is false, only an inserted slice carrying a footnote can change it.
  let hasFootnotesCache: boolean | null = null;

  return (transactions, oldState, newState) => {
    const refType = newState.schema.nodes.footnote_reference;
    const defType = newState.schema.nodes.footnote_definition;
    if (!refType || !defType) return null;

    const docChanged = transactions.some((tr) => tr.docChanged);
    if (!docChanged && !cleanupPending) return null;
    // Undo/redo restores recorded footnotes: never rewrite it (see historyBatch), but the cache may be stale.
    if (isHistoryBatch(transactions)) {
      hasFootnotesCache = null;
      return null;
    }

    // Skip during IME composition — dispatching transactions mid-composition
    // can cause ProseMirror to reconcile the DOM, disrupting active CJK input
    // (cf. Tiptap #6758 emoji extension, #7126 TableOfContents).
    const isComposition = transactions.some(
      (tr) => tr.getMeta("composition") || tr.getMeta("uiEvent") === "input"
    );
    if (isComposition) {
      // Mark pending if doc changed during composition — cleanup will
      // run on the next non-composition transaction.
      if (docChanged) cleanupPending = true;
      return null;
    }

    // If cleanup was deferred from a composition transaction, clear
    // the flag and run cleanup/renumber unconditionally based on the
    // current state — the old ref deletion is no longer visible in
    // oldState vs newState since both already reflect the change.
    const wasDeferred = cleanupPending;
    cleanupPending = false;

    // A document known to hold no footnotes still holds none unless an
    // inserted slice brought one; then it is unknown until the next scan.
    if (hasFootnotesCache === false) {
      if (!transactionsInsertFootnote(transactions, refType, defType)) return null;
      hasFootnotesCache = null;
    }

    // The common edit: nothing in this batch could have removed a reference,
    // so there is nothing to clean up and no reason to read the document.
    if (!wasDeferred && !transactionsMayRemoveReference(transactions, refType)) return null;

    const newCollected = footnotesOf(newState.doc);
    const newRefLabels = newCollected.refLabels;
    const defs = newCollected.defs;
    hasFootnotesCache = newCollected.refs.length > 0 || defs.length > 0;
    if (!hasFootnotesCache) return null;

    if (!wasDeferred) {
      // Normal path: check if any ref was deleted in this transaction.
      // Per-label COUNTS, not label sets — deleting one of two
      // duplicate refs ([1,2,1] → [2,1]) leaves the set unchanged but
      // still requires renumbering.
      if (!hasRefCountDropped(footnotesOf(oldState.doc).refs, newCollected.refs)) return null;
    }
    // Deferred path: skip refDeleted check — cleanup needed regardless

    const orphanedDefs = defs.filter((d) => !newRefLabels.has(d.label));

    if (orphanedDefs.length === 0 && newRefLabels.size === 0) {
      if (defs.length > 0) {
        let tr = newState.tr;
        const sortedDefs = [...defs].sort((a, b) => b.pos - a.pos);
        for (const def of sortedDefs) {
          tr = tr.delete(def.pos, def.pos + def.size);
        }
        return tr;
      }
      return null;
    }

    if (orphanedDefs.length === 0) {
      return createRenumberTransaction(newState, refType, defType, newCollected);
    }

    return createCleanupAndRenumberTransaction(newState, newRefLabels, refType, defType, newCollected);
  };
}
