/**
 * Restore-completion listeners for the hot-exit startup path.
 *
 * Purpose: register the RESTORE_COMPLETE / RESTORE_FAILED listeners and hand
 *   back one promise for "how did the restore end", with a timeout.
 *
 * Split out of `restartWithHotExit.ts` so that file stays
 * inside the ~300-line gate.
 *
 * Key decisions:
 *   - Listener registration is AWAITED before the caller invokes the restore
 *     commands. Rust can emit RESTORE_COMPLETE before a not-yet-registered
 *     listener exists, and the restore would then hang until the timeout.
 *   - Both registrations are awaited to the END, whatever each one does. The
 *     two `listen()` calls run concurrently, and giving up at the first
 *     rejection abandoned the other one mid-flight: it went on to register a
 *     listener whose unlisten function nobody held, for the life of the window.
 *     A setup that fails unlistens whatever did register, then rethrows.
 *   - An outcome can be decided DURING registration: Rust may emit as soon as
 *     one listener exists. Cleanup at that moment has no unlisten functions to
 *     call yet, so the setup runs it again once they arrive and starts no
 *     timeout for a restore that has already ended.
 *
 * @coordinates-with restartWithHotExit.ts — the only caller
 * @module services/persistence/hotExit/restoreListeners
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { HOT_EXIT_EVENTS } from './types';

/** Not exported: it is only ever reached through `RestoreListenerHandle`, and
 *  a second exported name for the same shape is dead weight the knip ratchet
 *  is right to count. */
interface RestoreOutcome {
  success: boolean;
  error?: string;
}

/** Result type for restore listener setup */
export interface RestoreListenerHandle {
  /** Promise that resolves when restore completes or fails */
  resultPromise: Promise<RestoreOutcome>;
  /** Cleanup function to call if invoke fails */
  cleanup: () => void;
}

function isRejected<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

/**
 * Set up restore event listeners and wait for them to be ready.
 *
 * Rejects with the first registration failure, after unlistening any listener
 * that did register — a rejected setup leaves nothing behind.
 *
 * @param timeoutMs - Maximum time to wait for restore completion
 * @returns Handle with result promise and cleanup function
 */
export async function setupRestoreListeners(
  timeoutMs: number
): Promise<RestoreListenerHandle> {
  let resolved = false;
  let resolveResult: (result: RestoreOutcome) => void;
  let unlisteners: UnlistenFn[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const resultPromise = new Promise<RestoreOutcome>((resolve) => {
    resolveResult = resolve;
  });

  // Idempotent: each unlisten function is taken out of the list before it is
  // called, so a second cleanup (the caller's, after an outcome) calls nothing.
  const cleanup = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    const registered = unlisteners;
    unlisteners = [];
    for (const unlisten of registered) unlisten();
  };

  const handleResolve = (result: RestoreOutcome) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolveResult(result);
  };

  // AWAIT listener registration — see the header for why, and for why this is
  // allSettled rather than all.
  const registrations = await Promise.allSettled([
    listen(HOT_EXIT_EVENTS.RESTORE_COMPLETE, () => {
      handleResolve({ success: true });
    }),
    listen<{ error: string }>(HOT_EXIT_EVENTS.RESTORE_FAILED, (event) => {
      handleResolve({ success: false, error: event.payload.error });
    }),
  ]);

  for (const registration of registrations) {
    if (registration.status === 'fulfilled') unlisteners.push(registration.value);
  }

  const failure = registrations.find(isRejected);
  if (failure) {
    cleanup();
    throw failure.reason;
  }

  if (resolved) {
    // The outcome arrived while a listener was still registering.
    cleanup();
    return { resultPromise, cleanup };
  }

  // Set up timeout AFTER listeners are confirmed ready
  timeoutId = setTimeout(() => {
    handleResolve({ success: false, error: 'Restore timed out' });
  }, timeoutMs);

  return { resultPromise, cleanup };
}
