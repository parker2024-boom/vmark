// @vitest-environment node
/**
 * Hot Exit Restart Tests
 *
 * Tests for session capture, restore coordination, and proper session file lifecycle.
 * Critical: Session file must NOT be deleted until restore is confirmed complete.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { checkAndRestoreSession } from './restartWithHotExit';
import { migrateSession } from './schemaMigration';
import { HOT_EXIT_EVENTS, type SessionData } from './types';
import { restoreMainWindowState } from '../resilience/_hotExitRestore';
import { ASYNC_IMPORT_WAIT } from '@/test/waitBudget';

/** A fixed capture time (seconds); restore never compares it with the clock. */
const SESSION_TIMESTAMP = 1_768_478_400;

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}));

// Mock restoreMainWindowState to avoid store dependencies
// The actual restore logic is tested in useHotExitRestore.test.ts
vi.mock('../resilience/_hotExitRestore', () => ({
  restoreMainWindowState: vi.fn().mockResolvedValue(undefined),
}));

describe('checkAndRestoreSession', () => {
  let mockInvoke: Mock;
  let mockListen: Mock;
  let mockRestoreMainWindow: Mock;
  let eventListeners: Map<string, (event: { payload: unknown }) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke = invoke as Mock;
    mockListen = listen as Mock;
    mockRestoreMainWindow = restoreMainWindowState as Mock;
    eventListeners = new Map();

    // Mock listen to capture event handlers
    mockListen.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      eventListeners.set(eventName, handler);
      return Promise.resolve(() => {
        eventListeners.delete(eventName);
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The restore command has run, so the outcome listeners are armed. */
  const untilRestoreInvoked = () =>
    vi.waitFor(() => expect(mockRestoreMainWindow).toHaveBeenCalled(), ASYNC_IMPORT_WAIT);

  /**
   * Drain pending promise reactions until `done()` holds. Moves no clock, so it
   * is safe under fake timers, where `vi.waitFor` advances time on each poll.
   */
  async function untilSettled(done: () => boolean): Promise<void> {
    for (let turn = 0; turn < 1000 && !done(); turn++) await Promise.resolve();
    expect(done()).toBe(true);
  }

  it('should return false when no session exists', async () => {
    mockInvoke.mockResolvedValueOnce(null); // hot_exit_inspect_session returns null

    const result = await checkAndRestoreSession();

    expect(result).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('hot_exit_inspect_session');
    // Should NOT call clear_session when no session exists
    expect(mockInvoke).not.toHaveBeenCalledWith('hot_exit_clear_session');
  });

  it('should NOT delete session until restore-complete event is received', async () => {
    // Single-window session (main only) - uses legacy hot_exit_restore
    const mockSession = {
      version: 1,
      timestamp: SESSION_TIMESTAMP,
      vmark_version: '0.3.24',
      windows: [{ window_label: 'main', is_main_window: true, tabs: [] }],
    };

    mockInvoke
      .mockResolvedValueOnce(mockSession) // hot_exit_inspect_session
      .mockResolvedValueOnce(undefined)   // hot_exit_restore
      .mockResolvedValueOnce(undefined);  // hot_exit_clear_session

    // Start restore but don't emit complete event yet
    const restorePromise = checkAndRestoreSession();

    await untilRestoreInvoked();

    // Verify restore was called (single-window uses legacy command)
    // Session is migrated from v1 to current schema before restore
    const migratedSession = migrateSession(mockSession as unknown as SessionData);
    expect(mockInvoke).toHaveBeenCalledWith('hot_exit_restore', { session: migratedSession });

    // Verify clear_session has NOT been called yet (waiting for event)
    const clearCalls = mockInvoke.mock.calls.filter(
      call => call[0] === 'hot_exit_clear_session'
    );
    expect(clearCalls.length).toBe(0);

    // Now emit the restore-complete event
    const completeHandler = eventListeners.get(HOT_EXIT_EVENTS.RESTORE_COMPLETE);
    if (completeHandler) {
      completeHandler({ payload: {} });
    }

    // Wait for promise to resolve
    const result = await restorePromise;

    // NOW clear_session should have been called
    expect(mockInvoke).toHaveBeenCalledWith('hot_exit_clear_session');
    expect(result).toBe(true);
  });

  it('should NOT delete session if restore fails', async () => {
    // Single-window session (main only) - uses legacy hot_exit_restore
    const mockSession = {
      version: 1,
      timestamp: SESSION_TIMESTAMP,
      vmark_version: '0.3.24',
      windows: [{ window_label: 'main', is_main_window: true, tabs: [] }],
    };

    mockInvoke
      .mockResolvedValueOnce(mockSession) // hot_exit_inspect_session
      .mockResolvedValueOnce(undefined);  // hot_exit_restore

    // Start restore
    const restorePromise = checkAndRestoreSession();

    await untilRestoreInvoked();

    // Emit restore-failed event
    const failedHandler = eventListeners.get(HOT_EXIT_EVENTS.RESTORE_FAILED);
    if (failedHandler) {
      failedHandler({ payload: { error: 'Test error' } });
    }

    // Wait for promise to resolve
    const result = await restorePromise;

    // clear_session should NOT have been called
    const clearCalls = mockInvoke.mock.calls.filter(
      call => call[0] === 'hot_exit_clear_session'
    );
    expect(clearCalls.length).toBe(0);
    expect(result).toBe(false);
  });

  it('should handle restore timeout gracefully without deleting session', async () => {
    // Single-window session (main only) - uses legacy hot_exit_restore
    const mockSession = {
      version: 1,
      timestamp: SESSION_TIMESTAMP,
      vmark_version: '0.3.24',
      windows: [{ window_label: 'main', is_main_window: true, tabs: [] }],
    };

    mockInvoke
      .mockResolvedValueOnce(mockSession) // hot_exit_inspect_session
      .mockResolvedValueOnce(undefined);  // hot_exit_restore

    vi.useFakeTimers();
    let settled = false;
    const restorePromise = checkAndRestoreSession(100).finally(() => {
      settled = true;
    });
    // The timeout is armed before the restore command runs; wait for that
    // command without moving the clock, then move it to either side of 100ms.
    await untilSettled(() => mockRestoreMainWindow.mock.calls.length > 0);

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await restorePromise;

    // clear_session should NOT have been called on timeout
    const clearCalls = mockInvoke.mock.calls.filter(
      call => call[0] === 'hot_exit_clear_session'
    );
    expect(clearCalls.length).toBe(0);
    expect(result).toBe(false);
  });

  it('should clean up event listeners after successful restore', async () => {
    // Single-window session (main only) - uses legacy hot_exit_restore
    const mockSession = {
      version: 1,
      timestamp: SESSION_TIMESTAMP,
      vmark_version: '0.3.24',
      windows: [{ window_label: 'main', is_main_window: true, tabs: [] }],
    };

    let unlistenCalls = 0;
    mockListen.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      eventListeners.set(eventName, handler);
      return Promise.resolve(() => {
        unlistenCalls++;
        eventListeners.delete(eventName);
      });
    });

    mockInvoke
      .mockResolvedValueOnce(mockSession)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const restorePromise = checkAndRestoreSession();

    await untilRestoreInvoked();

    // Emit complete
    const completeHandler = eventListeners.get(HOT_EXIT_EVENTS.RESTORE_COMPLETE);
    if (completeHandler) {
      completeHandler({ payload: {} });
    }

    await restorePromise;

    // Verify listeners were cleaned up
    expect(unlistenCalls).toBeGreaterThan(0);
  });

  it('should call restoreMainWindowState directly after invoke returns', async () => {
    const mockSession = {
      version: 2,
      timestamp: SESSION_TIMESTAMP,
      vmark_version: '0.3.30',
      windows: [{ window_label: 'main', is_main_window: true, tabs: [] }],
    };

    mockInvoke
      .mockResolvedValueOnce(mockSession) // hot_exit_inspect_session
      .mockResolvedValueOnce(undefined)   // hot_exit_restore
      .mockResolvedValueOnce(undefined);  // hot_exit_clear_session

    const restorePromise = checkAndRestoreSession();

    await untilRestoreInvoked();

    // Verify restoreMainWindowState was called (bypasses RESTORE_START event race)
    expect(mockRestoreMainWindow).toHaveBeenCalled();

    // Emit complete to finish the test
    const completeHandler = eventListeners.get(HOT_EXIT_EVENTS.RESTORE_COMPLETE);
    if (completeHandler) {
      completeHandler({ payload: {} });
    }

    await restorePromise;
  });

  it('handleResolve guard: firing failed after complete is a no-op (line 242 return branch)', async () => {
    // Covers the `if (resolved) return;` true branch in handleResolve
    const mockSession = {
      version: 2,
      timestamp: SESSION_TIMESTAMP,
      vmark_version: '0.3.30',
      windows: [{ window_label: 'main', is_main_window: true, tabs: [] }],
    };

    mockInvoke
      .mockResolvedValueOnce(mockSession)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const restorePromise = checkAndRestoreSession();

    await untilRestoreInvoked();

    // Fire COMPLETE first — sets resolved = true
    const completeHandler = eventListeners.get(HOT_EXIT_EVENTS.RESTORE_COMPLETE);
    if (completeHandler) {
      completeHandler({ payload: {} });
    }

    // Fire FAILED after — handleResolve hits `if (resolved) return;` (line 242)
    const failedHandler = eventListeners.get(HOT_EXIT_EVENTS.RESTORE_FAILED);
    if (failedHandler) {
      failedHandler({ payload: { error: 'late noise' } });
    }

    const result = await restorePromise;
    // Result is still true (first resolve wins)
    expect(result).toBe(true);
  });
});
