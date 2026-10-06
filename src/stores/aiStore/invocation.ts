/**
 * AI Invocation store — singleton guard for AI genie invocation.
 *
 * Tracks isRunning, elapsed seconds, error state, and a brief success
 * flash. Module-level interval/timeout singletons keep timers exclusive.
 * A failure may carry the means to re-run the request that failed, which is
 * what the status bar's Retry calls.
 *
 * @module stores/aiStore/invocation
 */

import { create } from "zustand";

interface AiInvocationState {
  isRunning: boolean;
  requestId: string | null;
  elapsedSeconds: number;
  error: string | null;
  /**
   * Re-runs the request `error` belongs to, or null when that failure has
   * nothing to re-run (provider validation, a refused cancel). Set only
   * together with `error`, so Retry can never re-run some other request.
   */
  retry: (() => void) | null;
  showSuccess: boolean;
  /**
   * Whether the status row has anything to say — DERIVED, never set by hand.
   * It is exactly `isRunning || error !== null || showSuccess`,
   * and six transitions each restated that by hand, so any one of them could
   * disagree with the three fields it summarizes and nothing would notice. It
   * stays part of the state because subscribers select it; `publish` below is
   * the one place that computes it.
   */
  hasActiveStatus: boolean;
  /**
   * How many cancels this store has seen. A run captures this
   * BEFORE the awaits that precede registration and hands it to `tryStart`;
   * a cancel in between bumps it, so the run is refused instead of dispatching
   * a provider request the user already stopped. Monotonic — `cancel()` must
   * never reset it, or the intent it just minted would be erased.
   */
  cancelEpoch: number;
  /**
   * How many invocations this store has STARTED. Monotonic, and
   * — like `cancelEpoch` — it must survive `cancel()`: it is what lets an
   * asynchronous failure belonging to an earlier run tell "the store is idle
   * because my run ended" apart from "the store is idle because a LATER run
   * came and went". `isRunning` alone cannot: both read false.
   */
  startEpoch: number;
}

interface AiInvocationActions {
  /**
   * Try to start an invocation. Returns false if already running, or — when
   * `sinceEpoch` is given — if a cancel landed after that epoch was taken.
   * The check and the claim are ONE store write, so a cancel
   * cannot slip between them.
   */
  tryStart: (requestId: string, sinceEpoch?: number) => boolean;
  /**
   * Mark invocation as finished successfully. Shows brief success flash.
   *
   * REQUEST-SCOPED: pass the request that is finishing. A terminal
   * frame from a cancelled or superseded request would otherwise see a NEWER
   * invocation running and end it — the completion of one request silently
   * killing another's. Omitting the id keeps the unscoped behaviour for
   * callers that own the whole store (tests, teardown).
   */
  finish: (requestId?: string) => void;
  /** Cancel the current invocation and reset all state. */
  cancel: () => void;
  /**
   * Set an error message. Stops the invocation.
   *
   * REQUEST-SCOPED the same way: a late failure belonging to an
   * old request must not terminate and overwrite a newer one. Callers with no
   * request of their own — provider validation, a cancel that could not reach
   * Rust — pass nothing and report against whatever is current.
   */
  setError: (message: string, requestId?: string, retry?: () => void) => void;
  /** Dismiss the current error. */
  dismissError: () => void;
  /**
   * Clear the current error and re-run the request that failed, once. Without
   * a retry it only clears the error.
   */
  retryFailed: () => void;
}

const initialState: AiInvocationState = {
  isRunning: false,
  requestId: null,
  elapsedSeconds: 0,
  error: null,
  retry: null,
  showSuccess: false,
  hasActiveStatus: false,
  cancelEpoch: 0,
  startEpoch: 0,
};

/**
 * A status transition with `hasActiveStatus` DERIVED from the state the patch
 * produces. Every write that can change the status row goes
 * through this, so the flag cannot disagree with the three fields it
 * summarizes. It reads the MERGED next state, not the patch, so a partial
 * patch (the success-flash timeout sets only `showSuccess`) derives correctly.
 */
function withStatus(
  patch: Partial<AiInvocationState>,
): (s: AiInvocationState) => Partial<AiInvocationState> {
  return (s) => {
    const next = { ...s, ...patch };
    return {
      ...patch,
      hasActiveStatus: next.isRunning || next.error !== null || next.showSuccess,
    };
  };
}

let elapsedInterval: ReturnType<typeof setInterval> | null = null;
let successTimeout: ReturnType<typeof setTimeout> | null = null;

function clearTimers() {
  if (elapsedInterval !== null) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
  if (successTimeout !== null) {
    clearTimeout(successTimeout);
    successTimeout = null;
  }
}

/** Manages AI genie invocation concurrency — singleton guard, elapsed timer, error state, and success flash. Use selectors, not destructuring. */
export const useAiInvocationStore = create<AiInvocationState & AiInvocationActions>(
  (set, get) => ({
    ...initialState,

    tryStart: (requestId, sinceEpoch) => {
      if (get().isRunning) return false;
      if (sinceEpoch !== undefined && sinceEpoch !== get().cancelEpoch) return false;
      clearTimers();
      // WALL-CLOCK, not a tick count. `setInterval` is a lower
      // bound, not a schedule: a backgrounded webview throttles timers to
      // seconds or minutes, and a machine asleep fires none at all — so
      // counting callbacks under-reported a long run by however long the app
      // was not foregrounded, on the one number the user checks to decide
      // whether a provider has hung.
      const startedAt = Date.now();
      // The timer is armed BEFORE the state is published. Zustand
      // notifies subscribers synchronously inside `set`, so a subscriber that
      // cancels during it ran `clearTimers()` while this interval did not yet
      // exist — and the assignment that followed left an orphan ticking
      // `elapsedSeconds` over a cancelled, or later, invocation forever.
      elapsedInterval = setInterval(() => {
        set({ elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
      }, 1000);
      set(withStatus({
        isRunning: true,
        requestId,
        elapsedSeconds: 0,
        error: null,
        retry: null,
        showSuccess: false,
        startEpoch: get().startEpoch + 1,
      }));
      return true;
    },

    finish: (requestId) => {
      if (!get().isRunning) return;
      if (requestId !== undefined && get().requestId !== requestId) return;
      clearTimers();
      // Armed before publishing, for the same reason as `tryStart`: a
      // subscriber that starts another request inside this `set` would run a
      // `clearTimers()` that could not see this timeout, and it would later
      // hide the NEW request's active status.
      successTimeout = setTimeout(() => {
        set(withStatus({ showSuccess: false }));
      }, 3000);
      set(withStatus({
        isRunning: false,
        requestId: null,
        elapsedSeconds: 0,
        error: null,
        retry: null,
        showSuccess: true,
      }));
    },

    cancel: () => {
      clearTimers();
      // BOTH epochs SURVIVE the reset. `cancelEpoch` advances: it is the cancel
      // intent a not-yet-registered run has to notice.
      // `startEpoch` is merely carried, so a later failure can still tell which
      // run the idle store belongs to. Spreading `initialState` alone
      // would put either back to 0 and drop what it records.
      set(withStatus({
        ...initialState,
        cancelEpoch: get().cancelEpoch + 1,
        startEpoch: get().startEpoch,
      }));
    },

    setError: (message, requestId, retry) => {
      if (requestId !== undefined && get().requestId !== requestId) return;
      clearTimers();
      set(withStatus({
        isRunning: false,
        requestId: null,
        elapsedSeconds: 0,
        error: message,
        retry: retry ?? null,
        showSuccess: false,
      }));
    },

    dismissError: () => {
      // `=== null`, not falsiness. `setError` accepts ANY string,
      // and an empty one is reachable — `errorMessage(new Error(""))` is "" —
      // so a truthiness test left that error set AND the status row pinned open
      // with nothing to dismiss it.
      if (get().error === null) return;
      set(withStatus({ error: null, retry: null }));
    },

    retryFailed: () => {
      const { retry } = get();
      // Cleared BEFORE the re-run: the run's own `tryStart` publishes a fresh
      // status, and a synchronous failure inside it must land on a clean slate
      // rather than be wiped by a dismissal that runs after it.
      get().dismissError();
      retry?.();
    },
  })
);
