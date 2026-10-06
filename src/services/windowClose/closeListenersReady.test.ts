// @vitest-environment node
// WI-RA7C.8 — the close-listener barrier: level-triggered, budgeted, carries
// the outcome, and independent of the menu barrier it sits beside.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  signalCloseListenersMounted,
  waitForCloseListeners,
  resetCloseListenersForTest,
} from "./closeListenersReady";
import {
  resetMenuCommandsForTest,
  signalMenuCommandsMounted,
  waitForMenuCommands,
} from "@/services/commands/menuCommandsReady";

// The barrier reports through the app's error logger, which writes to
// `console.error`. Spied rather than module-mocked: the test setup has already
// loaded the barrier with the real logger.
let reported: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
  resetCloseListenersForTest();
  resetMenuCommandsForTest();
});
afterEach(() => {
  reported.mockRestore();
  vi.useRealTimers();
});

describe("close-listener readiness barrier", () => {
  it("resolves a waiter that arrived first, and one that arrives after", async () => {
    const early = waitForCloseListeners(60_000);
    signalCloseListenersMounted(true);
    await expect(early).resolves.toBe(true);
    await expect(waitForCloseListeners(60_000)).resolves.toBe(true);
  });

  it("carries a failed registration to every waiter", async () => {
    const waiters = [waitForCloseListeners(60_000), waitForCloseListeners(60_000)];
    signalCloseListenersMounted(false);
    await expect(Promise.all(waiters)).resolves.toEqual([false, false]);
  });

  it("resolves false when the budget runs out, and stays unsettled for the next waiter", async () => {
    vi.useFakeTimers();
    const waited = waitForCloseListeners(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(waited).resolves.toBe(false);

    signalCloseListenersMounted(true);
    await expect(waitForCloseListeners(2_000)).resolves.toBe(true);
  });

  it.each([0, -5, Number.NaN])("a budget of %s does not hang", async (budget) => {
    vi.useFakeTimers();
    const waited = waitForCloseListeners(budget);
    await vi.advanceTimersByTimeAsync(0);
    await expect(waited).resolves.toBe(false);
  });

  it("keeps the first verdict and reports a second one that disagrees", async () => {
    signalCloseListenersMounted(false);
    signalCloseListenersMounted(true);

    await expect(waitForCloseListeners(60_000)).resolves.toBe(false);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0].join(" ")).toContain("re-signalled as true");
  });

  it("says nothing about an identical repeat", () => {
    signalCloseListenersMounted(true);
    signalCloseListenersMounted(true);
    expect(reported).not.toHaveBeenCalled();
  });

  it("is a different fact from the menu barrier", async () => {
    vi.useFakeTimers();
    signalMenuCommandsMounted(true);
    const close = waitForCloseListeners(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(close).resolves.toBe(false);

    resetMenuCommandsForTest();
    signalCloseListenersMounted(true);
    const menu = waitForMenuCommands(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(menu).resolves.toBe(false);
  });

  it("a reset settles pending waiters instead of leaving their timers running", async () => {
    vi.useFakeTimers();
    const waited = waitForCloseListeners(60_000);
    resetCloseListenersForTest();
    await expect(waited).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
