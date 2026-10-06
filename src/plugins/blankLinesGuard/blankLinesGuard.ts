/**
 * blankLinesGuard
 *
 * Purpose: Keep the `blankLinesBefore` attribute (blank-line preservation) from
 * being duplicated by edits. ProseMirror's split copies a node's attributes to
 * BOTH halves, so a paragraph carrying a captured run of N blank lines would
 * give the newly-created second paragraph N too — emitting N spurious blank
 * lines on the next serialize (plan ADR-5).
 *
 * Rule: null `blankLinesBefore` on any block that this transaction newly
 * created — the second half of a split, or a fully-inserted (pasted) block —
 * while leaving parse-captured values and in-place content edits untouched.
 * "Newly created" is detected geometrically against the transaction's changed
 * ranges (mapped to the resulting doc): a block whose start is strictly inside
 * a changed range (split's second half) or whose whole span is contained in one
 * (an inserted block). A split's first half starts at/before the range and is
 * not fully contained, so it keeps its value; typing inside a block changes an
 * inline range that neither starts a block nor contains one.
 *
 * Cost: the guard runs on every transaction, so it must not walk the document.
 * A step that inserts only inline content — a typed character, pasted text —
 * cannot create a block, and is skipped by reading its slice. For the steps
 * that can, only the blocks overlapping their changed ranges are visited.
 *
 * Programmatic content loads (initial parse, external sync via
 * setContentWithoutHistory) are skipped entirely — they replace the whole doc
 * with freshly parse-captured, authoritative values but would read as a
 * full-document insertion here. They are marked `preventUpdate`; user edits are
 * not.
 *
 * @coordinates-with plugins/shared/sourceLineAttr.ts — blankLinesBefore attr
 * @coordinates-with utils/markdownPipeline/mdastToProseMirror.ts — capture
 * @module plugins/blankLinesGuard/blankLinesGuard
 */
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ReplaceStep, type Step } from "@tiptap/pm/transform";
import { isHistoryBatch } from "@/plugins/shared/historyBatch";

const blankLinesGuardKey = new PluginKey("blankLinesGuard");

/** True if the node type declares the blankLinesBefore attribute. */
function hasBlankLinesAttr(node: PMNode): boolean {
  const attrs = node.type.spec.attrs;
  return Boolean(attrs && "blankLinesBefore" in attrs);
}

/**
 * Whether `step` can put a block into the document. A plain replace whose
 * slice holds only inline content cannot: its changed range lies inside one
 * textblock. Any other step that changes positions is taken to be structural.
 */
function mayCreateBlock(step: Step): boolean {
  if (!(step instanceof ReplaceStep)) return true;
  const { content } = step.slice;
  for (let i = 0; i < content.childCount; i += 1) {
    if (content.child(i).isBlock) return true;
  }
  return false;
}

/**
 * Collect the changed ranges of the steps that can create a block, expressed
 * in the coordinate space of the final document.
 */
function changedRanges(transactions: readonly Transaction[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  transactions.forEach((transaction, ti) => {
    if (!transaction.docChanged) return;
    transaction.mapping.maps.forEach((map, mi) => {
      if (!mayCreateBlock(transaction.steps[mi])) return;
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        // Forward through the rest of this transaction's steps...
        const rest = transaction.mapping.slice(mi + 1);
        let from = rest.map(newStart, -1);
        let to = rest.map(newEnd, 1);
        // ...then through every later transaction, to reach final coordinates.
        for (let tj = ti + 1; tj < transactions.length; tj++) {
          from = transactions[tj].mapping.map(from, -1);
          to = transactions[tj].mapping.map(to, 1);
        }
        ranges.push({ from, to });
      });
    });
  });
  return ranges;
}

/** ProseMirror plugin enforcing the clear-on-edit rule above. */
export function blankLinesGuard(): Plugin {
  return new Plugin({
    key: blankLinesGuardKey,
    appendTransaction(transactions, _oldState, newState) {
      // A programmatic content load (initial parse, external sync) replaces the
      // whole doc and carries freshly parse-captured blankLinesBefore that are
      // authoritative and must be KEPT — but a full-doc replace looks like an
      // insertion to the geometric test below, so without this it would clear
      // every value and break preservation on the primary open→save path.
      // setContentWithoutHistory marks these `preventUpdate`; genuine user
      // edits (split, paste) never set it.
      if (transactions.some((t) => t.getMeta("preventUpdate"))) return null;
      // An undo/redo restores the attributes it recorded; resetting them here
      // would also corrupt the undo history (plugins/shared/historyBatch).
      if (isHistoryBatch(transactions)) return null;

      const ranges = changedRanges(transactions);
      if (ranges.length === 0) return null;

      // A block two ranges both cover is reset once, in document order.
      const created = new Set<number>();
      for (const r of ranges) {
        // Every block the rule below can match starts inside [r.from, r.to),
        // so only the nodes overlapping the range need looking at.
        newState.doc.nodesBetween(r.from, r.to, (node, pos) => {
          if (!node.isBlock || !hasBlankLinesAttr(node)) return;
          if (node.attrs.blankLinesBefore == null) return;
          const end = pos + node.nodeSize;
          // "Newly created" = start strictly inside a changed range (a split's
          // second half) OR whole span contained in one (an inserted/pasted
          // block). The first disjunct MUST be upper-bounded by `pos < r.to`:
          // without it, `pos > r.from` matches every block positioned after any
          // edit, clearing preserved gaps throughout the document on each keystroke.
          if ((pos > r.from && pos < r.to) || (pos >= r.from && end <= r.to)) created.add(pos);
        });
      }
      if (created.size === 0) return null;

      const tr = newState.tr;
      for (const pos of [...created].sort((a, b) => a - b)) {
        tr.setNodeAttribute(pos, "blankLinesBefore", null);
      }
      return tr;
    },
  });
}
