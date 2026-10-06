/**
 * Composition Write Gate
 *
 * Purpose: what a writer that is NOT the user's typing asks before it changes
 * a WYSIWYG document — an AI client's edit, a content sync from the store.
 *
 * While an IME composition is in progress the browser owns a stretch of the
 * document: the preedit text, and the DOM node it lives in. A transaction
 * dispatched into that redraws the node under the composition, which WebKit
 * answers by committing or dropping it, and it moves text the composition
 * guard is about to clean up after. The guard survives such a write (its
 * anchor follows or retires), but surviving is not the same as the write
 * being right. The write should wait, or be refused.
 *
 * Key decisions:
 *   - "In progress" includes the grace period after `compositionend`. The
 *     guard's cleanup runs in the frame that follows the event, and a write
 *     landing between the two is as badly placed as one mid-composition.
 *   - Two primitives, because writers come in two kinds. One that can simply
 *     happen later (a content sync) defers. One that must report its result
 *     now (an MCP handler answering a client) asks, and refuses.
 *   - A deferred write is handed over as a FUNCTION and run later, so it reads
 *     the editor state as it is then. A transaction built now would be for a
 *     document that no longer exists by the time it could be applied.
 *   - Deferred writes for one view keep their order, and a write submitted
 *     while others are still waiting joins the back of the line even if the
 *     composition has just settled — otherwise it would overtake them.
 *   - Waiting rides on the queue the composition guard already flushes after
 *     its cleanup; nothing polls while the user composes.
 *
 * Known limitations:
 *   - Deferred writes are dropped if the editor is destroyed first: the
 *     document they were for went with the view.
 *   - Source mode needs none of this. Its content sync already defers through
 *     `runOrQueueCodeMirrorAction`.
 *
 * @coordinates-with utils/imeGuard.ts — composition state, the grace period, the deferred queue
 * @coordinates-with plugins/compositionGuard/tiptap.ts — flushes the queue after its cleanup
 * @module services/ime/compositionWriteGate
 */

import type { EditorView } from "@tiptap/pm/view";
import {
  IME_GRACE_PERIOD_MS,
  isProseMirrorComposing,
  isProseMirrorInCompositionGrace,
  runOrQueueProseMirrorAction,
} from "@/utils/imeGuard";

/** Whether a gated write ran before the call returned, or was put off. */
export type GatedWrite = "applied" | "deferred";

/** Writes waiting for a view's composition to settle, oldest first. */
const waiting = new WeakMap<EditorView, Array<() => void>>();

/**
 * True while an IME composition owns part of the view's document: one is in
 * progress, or one ended so recently that its cleanup may not have run.
 *
 * A writer that cannot wait checks this and refuses, so its caller learns the
 * document was not changed.
 */
export function isCompositionInProgress(view: EditorView | null | undefined): boolean {
  return isProseMirrorComposing(view) || isProseMirrorInCompositionGrace(view);
}

/** Run every waiting write once the view's composition has settled. */
function drainWhenSettled(view: EditorView): void {
  if (view.isDestroyed) {
    waiting.delete(view);
    return;
  }
  if (isProseMirrorComposing(view)) {
    // Queued until the composition guard flushes, after its cleanup.
    runOrQueueProseMirrorAction(view, () => drainWhenSettled(view));
    return;
  }
  if (isProseMirrorInCompositionGrace(view)) {
    setTimeout(() => drainWhenSettled(view), IME_GRACE_PERIOD_MS);
    return;
  }

  const writes = waiting.get(view) ?? [];
  waiting.delete(view);
  // One failing write must not swallow the ones behind it; the first failure
  // is still reported once they have all had their turn.
  const failures: unknown[] = [];
  for (const write of writes) {
    try {
      write();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Run `write` now if no composition is in progress and nothing is waiting;
 * otherwise once the composition has ended and been cleaned up.
 *
 * `write` must read `view.state` when it runs, not capture it beforehand.
 */
export function writeWhenCompositionSettles(view: EditorView, write: () => void): GatedWrite {
  const queue = waiting.get(view);
  if (queue) {
    queue.push(write);
    return "deferred";
  }
  if (!isCompositionInProgress(view)) {
    write();
    return "applied";
  }
  waiting.set(view, [write]);
  drainWhenSettled(view);
  return "deferred";
}
