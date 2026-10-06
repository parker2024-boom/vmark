// @vitest-environment node
// WI-RA10A.11 — a failed or early-resolved listener setup leaves no listener
// registered: every `listen()` that succeeded is unlistened exactly once.
/**
 * `setupRestoreListeners` registers two listeners concurrently. Awaiting them
 * with `Promise.all` threw away the unlisten function of the one that
 * registered when the other was rejected, so that listener stayed registered
 * for the life of the window with no handle left to remove it.
 *
 * `listen` is the boundary being modelled: each call hands back a deferred the
 * test settles, and records the handler so an event can be fired at it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface Registration {
  event: string;
  handler: (event: { payload: unknown }) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
  unlisten: ReturnType<typeof vi.fn>;
}

const registrations: Registration[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) =>
    new Promise<() => void>((resolve, reject) => {
      const unlisten = vi.fn();
      registrations.push({
        event,
        handler,
        resolve: () => resolve(unlisten),
        reject,
        unlisten,
      });
    }),
}));

import { setupRestoreListeners } from "./restoreListeners";
import { HOT_EXIT_EVENTS } from "./types";

function registration(event: string): Registration {
  const found = registrations.find((r) => r.event === event);
  if (!found) throw new Error(`listen() was never called for ${event}`);
  return found;
}

const complete = () => registration(HOT_EXIT_EVENTS.RESTORE_COMPLETE);
const failed = () => registration(HOT_EXIT_EVENTS.RESTORE_FAILED);

beforeEach(() => {
  registrations.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("setupRestoreListeners — a rejected registration", () => {
  it("unlistens the listener that DID register when the other is rejected", async () => {
    const setup = setupRestoreListeners(1000);
    complete().resolve();
    failed().reject(new Error("event plugin unavailable"));

    await expect(setup).rejects.toThrow("event plugin unavailable");
    expect(complete().unlisten).toHaveBeenCalledTimes(1);
  });

  it("holds in the mirrored order", async () => {
    const setup = setupRestoreListeners(1000);
    complete().reject(new Error("event plugin unavailable"));
    failed().resolve();

    await expect(setup).rejects.toThrow("event plugin unavailable");
    expect(failed().unlisten).toHaveBeenCalledTimes(1);
  });

  it("waits for the slower registration instead of abandoning it", async () => {
    // The rejection lands FIRST. Giving up there is what leaked: the second
    // listen() was still in flight and registered a listener nobody held.
    const setup = setupRestoreListeners(1000);
    let settled = false;
    void setup.catch(() => {}).finally(() => {
      settled = true;
    });
    failed().reject(new Error("event plugin unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    complete().resolve();
    await expect(setup).rejects.toThrow("event plugin unavailable");
    expect(complete().unlisten).toHaveBeenCalledTimes(1);
  });

  it("reports the first rejection when both are rejected, and leaves no timer", async () => {
    const setup = setupRestoreListeners(1000);
    complete().reject(new Error("first"));
    failed().reject(new Error("second"));

    await expect(setup).rejects.toThrow("first");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timeout for a setup that failed", async () => {
    const setup = setupRestoreListeners(1000);
    complete().resolve();
    failed().reject(new Error("event plugin unavailable"));

    await expect(setup).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("setupRestoreListeners — an event that arrives during registration", () => {
  it("unlistens both listeners and starts no timeout", async () => {
    // Rust can emit as soon as ONE listener exists. The outcome is then decided
    // before either unlisten function has been handed back.
    const setup = setupRestoreListeners(1000);
    complete().resolve();
    complete().handler({ payload: undefined });
    failed().resolve();

    const handle = await setup;
    await expect(handle.resultPromise).resolves.toEqual({ success: true });
    expect(complete().unlisten).toHaveBeenCalledTimes(1);
    expect(failed().unlisten).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("setupRestoreListeners — both registered", () => {
  async function ready(timeoutMs = 1000) {
    const setup = setupRestoreListeners(timeoutMs);
    complete().resolve();
    failed().resolve();
    return setup;
  }

  it("resolves success on RESTORE_COMPLETE and unlistens both once", async () => {
    const handle = await ready();
    complete().handler({ payload: undefined });

    await expect(handle.resultPromise).resolves.toEqual({ success: true });
    expect(complete().unlisten).toHaveBeenCalledTimes(1);
    expect(failed().unlisten).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves the failure with its message on RESTORE_FAILED", async () => {
    const handle = await ready();
    failed().handler({ payload: { error: "window 2 could not be created" } });

    await expect(handle.resultPromise).resolves.toEqual({
      success: false,
      error: "window 2 could not be created",
    });
  });

  it("times out, unlistening both", async () => {
    const handle = await ready(250);
    await vi.advanceTimersByTimeAsync(250);

    await expect(handle.resultPromise).resolves.toEqual({
      success: false,
      error: "Restore timed out",
    });
    expect(complete().unlisten).toHaveBeenCalledTimes(1);
    expect(failed().unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps the first outcome when both events fire", async () => {
    const handle = await ready();
    complete().handler({ payload: undefined });
    failed().handler({ payload: { error: "late" } });

    await expect(handle.resultPromise).resolves.toEqual({ success: true });
    expect(complete().unlisten).toHaveBeenCalledTimes(1);
    expect(failed().unlisten).toHaveBeenCalledTimes(1);
  });

  it("cleanup() unlistens both, cancels the timeout, and is safe to repeat", async () => {
    const handle = await ready();
    handle.cleanup();
    handle.cleanup();

    expect(complete().unlisten).toHaveBeenCalledTimes(1);
    expect(failed().unlisten).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
