/**
 * closeListenersReady — the second barrier the window-ready handshake waits on.
 *
 * Purpose: Rust sends `app:quit-requested` and `window:close-requested` only
 *   to a window that has announced itself ready, and emits them once. The
 *   announcement used to follow the MENU listener alone, so in the gap before
 *   `useWindowClose` had registered its own listeners a quit request went to
 *   nobody: the window never answered, and quit sat until Rust's ten-second
 *   retry. This is the fact the handshake was missing — "the close and quit
 *   listeners are registered" — signalled by the hook that registers them.
 *
 * Key decisions:
 *   - Same shape, same rules as the menu barrier (`utils/readinessBarrier`):
 *     level-triggered, budgeted, carries the outcome, first verdict wins.
 *   - Signalled only by a registration that is still mounted. Under React
 *     StrictMode the first mount is torn down before its `listen()` calls
 *     resolve and unregisters them on arrival; announcing on its behalf would
 *     claim listeners that no longer exist.
 *
 * @coordinates-with hooks/useWindowClose.ts — signals once its listeners are registered
 * @coordinates-with contexts/useWindowReady.ts — waits before emitting `ready`
 * @coordinates-with src-tauri/src/quit_broadcast.rs — defers a quit request to a window that is not ready
 * @module services/windowClose/closeListenersReady
 */

import { createReadinessBarrier } from "@/utils/readinessBarrier";
import { windowCloseError } from "@/utils/debug";

/** One webview per window, so module scope IS window scope here. */
const barrier = createReadinessBarrier((later, first) =>
  windowCloseError(
    `Close-listener readiness re-signalled as ${String(later)} after settling as ${String(first)}; keeping the first verdict.`,
  ),
);

/** Called once `useWindowClose` has registered its listeners, with WHETHER it did. */
export function signalCloseListenersMounted(mounted: boolean): void {
  barrier.signal(mounted);
}

/**
 * Resolve `true` when the close and quit listeners are registered, `false` if
 * registration failed or `budgetMs` elapses first. Never rejects.
 */
export function waitForCloseListeners(budgetMs: number): Promise<boolean> {
  return barrier.wait(budgetMs);
}

/** Reset between tests. Production has one window per module instance. */
export function resetCloseListenersForTest(): void {
  barrier.reset();
}
