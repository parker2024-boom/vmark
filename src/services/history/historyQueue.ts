/**
 * Purpose: order every operation on the history store, so two of them can
 * never interleave on one document's index.
 *
 * A history mutation is read-modify-write: read `index.json`, change the list
 * in memory, write snapshot files, write the index back. Two that overlap both
 * start from the same list, and the second write discards the first's change —
 * an entry is lost and its snapshot file is left with nothing naming it, or a
 * deleted entry comes back pointing at a file that is gone.
 *
 * Key decisions:
 *   - One chain per DOCUMENT, keyed by the document path exactly as it is
 *     hashed into a directory name. Histories of different documents share no
 *     file, so saving two documents at once stays concurrent.
 *   - Submission is synchronous. A caller is queued by the time its call
 *     returns, so operations run in the order they were asked for, not in the
 *     order some earlier `await` happened to settle.
 *   - Reads are queued as well. The index is written by truncating the file
 *     and then filling it, so a read that runs mid-write parses an empty file
 *     and reports a history as missing.
 *   - Removals that are not about one known document — clear everything, clear
 *     a workspace, delete a history named only by its hash — take the WHOLE
 *     store: they wait for every operation outstanding, and every operation
 *     submitted after them waits for them.
 *   - A failed operation delays its successors, it does not cancel them. The
 *     caller still sees its own rejection.
 *   - The map self-prunes: an entry is dropped once it settles, unless a later
 *     submission has replaced it.
 *
 * Known limitations:
 *   - A task must not submit to the queue and await the result: it would wait
 *     for itself. Composite operations call the unqueued steps directly.
 *   - Orders work inside one window. Two windows saving the same file still
 *     race on its index.
 *
 * @coordinates-with historyOperations.ts — per-document operations
 * @coordinates-with historyRecovery.ts — whole-store removals
 * @module services/history/historyQueue
 */

/** In-flight tail per document. Present only while work is pending for it. */
const chains = new Map<string, Promise<void>>();

/** The tail of the last whole-store operation. Never rejects. */
let barrier: Promise<void> = Promise.resolve();

/**
 * Run `task` after `previous`, which never rejects, and derive the tail a
 * successor waits on: settled when the task is, whatever its outcome.
 */
function chain<T>(
  previous: Promise<void>,
  task: () => Promise<T>,
): { run: Promise<T>; tail: Promise<void> } {
  const run = previous.then(task);
  const tail = run.then(
    () => {},
    () => {},
  );
  return { run, tail };
}

/**
 * Run `task` after every earlier operation on this document's history, and
 * after any whole-store operation submitted before it.
 *
 * @param documentPath - the path the history is keyed by, unmodified
 */
export function serializeHistory<T>(documentPath: string, task: () => Promise<T>): Promise<T> {
  // A whole-store operation empties the map when it is submitted, so a missing
  // entry means "nothing since the last barrier" and the barrier is the wait.
  const { run, tail } = chain(chains.get(documentPath) ?? barrier, task);
  chains.set(documentPath, tail);
  void tail.then(() => {
    if (chains.get(documentPath) === tail) chains.delete(documentPath);
  });
  return run;
}

/**
 * Run `task` with the whole history store to itself: after every operation
 * outstanding now, and ahead of every operation submitted later.
 */
export function serializeAllHistories<T>(task: () => Promise<T>): Promise<T> {
  const outstanding = Promise.all([barrier, ...chains.values()]).then(() => {});
  chains.clear();
  const { run, tail } = chain(outstanding, task);
  barrier = tail;
  return run;
}

/** Number of documents with history work outstanding. Test/diagnostic use. */
export function pendingHistoryCount(): number {
  return chains.size;
}
