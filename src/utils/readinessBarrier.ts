/**
 * readinessBarrier — announce a fact once; anything may wait for it.
 *
 * Purpose: the window-ready handshake must not tell Rust "this window is
 *   listening" before it is. Each listener that has to be in place first — the
 *   menu bridge, the close/quit listeners — gets one of these: the code that
 *   registers the listener signals it, and the handshake waits on it instead
 *   of guessing how long registration takes.
 *
 * Key decisions:
 *   - One-shot and LEVEL-triggered, not edge-triggered: a waiter arriving
 *     after the signal resolves immediately. Both orderings are real — the
 *     registering effect can finish before the handshake waits — and an
 *     edge-triggered latch would hang the handshake in one of them.
 *   - The wait is BUDGETED and resolves `false` rather than rejecting or
 *     hanging. A window that never announces itself is unusable; one that
 *     announces itself early is, at worst, the behaviour a timer gave.
 *   - The signal carries WHETHER the registration succeeded, and the first
 *     verdict wins. A disagreeing second signal is reported, never applied: a
 *     stray `true` over a `false` would restore the silence this removes.
 *
 * @coordinates-with services/commands/menuCommandsReady.ts — the menu listener's barrier
 * @coordinates-with services/windowClose/closeListenersReady.ts — the close/quit listeners' barrier
 * @coordinates-with contexts/useWindowReady.ts — waits on both before emitting `ready`
 * @module utils/readinessBarrier
 */

/** A fact that becomes true (or fails to) once, and can be waited for. */
export interface ReadinessBarrier {
  /** Report the outcome. The first report wins; a later one that disagrees is passed to `onConflict`. */
  signal: (ready: boolean) => void;
  /**
   * Resolve with the reported outcome, or `false` if `budgetMs` elapses first.
   * Never rejects — the caller must proceed either way. The two `false` cases
   * are deliberately one value: both mean "do not assume it is in place".
   */
  wait: (budgetMs: number) => Promise<boolean>;
  /** Forget the outcome and settle pending waiters with `false`. For tests. */
  reset: () => void;
}

/**
 * The largest delay `setTimeout` can hold: it stores the delay in a SIGNED
 * 32-bit integer, so anything above this overflows and the timer fires
 * IMMEDIATELY — the exact opposite of "wait longer". A negative delay fires
 * immediately too.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Bring a budget inside what `setTimeout` can actually honour.
 *
 * The failure this prevents is silent and inverted: a caller asking for a huge
 * budget got a barrier that expired on the next tick. Clamping high means
 * "effectively never", which is what such a caller means; NaN clamps to 0, the
 * documented degraded case, because a 24-day wait for a nonsense argument
 * would hang the handshake instead.
 */
export function clampWaitBudget(budgetMs: number): number {
  if (Number.isNaN(budgetMs)) return 0;
  return Math.min(Math.max(budgetMs, 0), MAX_TIMEOUT_MS);
}

/**
 * A fresh barrier. `onConflict(later, first)` is called when a second signal
 * disagrees with the first — that is a double registration, or a retry the
 * barrier cannot honour, and the one observable trace of it.
 */
export function createReadinessBarrier(
  onConflict: (later: boolean, first: boolean) => void,
): ReadinessBarrier {
  let settled = false;
  /** The reported outcome — meaningful only once `settled`. */
  let outcome = false;
  let waiters: Array<(signalled: boolean) => void> = [];

  return {
    signal(ready) {
      if (settled) {
        if (ready !== outcome) onConflict(ready, outcome);
        return;
      }
      settled = true;
      outcome = ready;
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve(ready);
    },

    wait(budgetMs) {
      if (settled) return Promise.resolve(outcome);
      const budget = clampWaitBudget(budgetMs);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          // Drop this waiter so a later signal cannot re-resolve a settled
          // promise and cannot retain it. The verdict is about what was true
          // when the budget expired.
          waiters = waiters.filter((w) => w !== onSignal);
          resolve(false);
        }, budget);

        const onSignal = (signalled: boolean) => {
          clearTimeout(timer);
          resolve(signalled);
        };

        waiters.push(onSignal);
      });
    },

    reset() {
      // SETTLE the pending waiters rather than dropping them: each waiter's
      // `onSignal` is what clears its own timer, so dropping the list would
      // leave a live timer — and an unresolved promise — running into the
      // next test.
      const pending = waiters;
      waiters = [];
      settled = false;
      outcome = false;
      for (const resolve of pending) resolve(false);
    },
  };
}
