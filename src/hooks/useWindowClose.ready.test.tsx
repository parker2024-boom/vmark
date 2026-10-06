// WI-RA7C.8 — useWindowClose tells the window-ready handshake when its close
// and quit listeners are actually registered: after the last `listen()`
// resolves, with the outcome, and never on behalf of a mount that has been
// torn down.
import { StrictMode } from "react";
import { render, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Registration = { event: string; resolve: () => void; reject: (error: Error) => void };
const registrations: Registration[] = [];
const unlistened: string[] = [];

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(
      (event: string) =>
        new Promise<() => void>((resolve, reject) => {
          registrations.push({
            event,
            resolve: () => resolve(() => { unlistened.push(event); }),
            reject,
          });
        }),
    ),
  }),
}));
vi.mock("@/contexts/WindowContext", () => ({ useWindowLabel: () => "main" }));
vi.mock("@/services/tabs/tabOperations", () => ({ closeTabWithDirtyCheck: vi.fn() }));
vi.mock("@/services/windowClose/windowCloseFlow", () => ({ runWindowCloseFlow: vi.fn() }));
const mockWindowCloseError = vi.fn();
vi.mock("@/utils/debug", () => ({
  windowCloseLog: vi.fn(),
  windowCloseWarn: vi.fn(),
  windowCloseError: (...args: unknown[]) => mockWindowCloseError(...args),
}));

import { useWindowClose } from "./useWindowClose";
import {
  resetCloseListenersForTest,
  waitForCloseListeners,
} from "@/services/windowClose/closeListenersReady";

function Harness() {
  useWindowClose();
  return null;
}

const CLOSE_EVENTS = ["menu:close", "window:close-requested", "app:quit-requested"];

/** Let the hook's awaits run. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/** Resolve the registration the hook is currently waiting on. */
async function registerNext(): Promise<string> {
  const next = registrations.shift();
  if (!next) throw new Error("the hook is not waiting on a listener");
  next.resolve();
  await flush();
  return next.event;
}

/** The barrier's verdict so far: `undefined` while nobody has signalled. */
function watchBarrier(): { verdict: () => boolean | undefined } {
  let verdict: boolean | undefined;
  void waitForCloseListeners(60_000).then((value) => { verdict = value; });
  return { verdict: () => verdict };
}

// The barrier itself reports a conflicting signal through the real logger
// (the test setup loaded it before this file's mocks), i.e. `console.error`.
let conflicts: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  registrations.length = 0;
  unlistened.length = 0;
  mockWindowCloseError.mockReset();
  conflicts = vi.spyOn(console, "error").mockImplementation(() => undefined);
  resetCloseListenersForTest();
});
afterEach(() => conflicts.mockRestore());

describe("useWindowClose — readiness", () => {
  it("signals once the last of its listeners is registered, and not before", async () => {
    const barrier = watchBarrier();
    render(<Harness />);
    await flush();

    const registered: string[] = [];
    registered.push(await registerNext());
    expect(barrier.verdict()).toBeUndefined();
    registered.push(await registerNext());
    expect(barrier.verdict()).toBeUndefined();
    registered.push(await registerNext());

    expect(registered).toEqual(CLOSE_EVENTS);
    expect(barrier.verdict()).toBe(true);
  });

  it("reports a registration that failed", async () => {
    const barrier = watchBarrier();
    render(<Harness />);
    await flush();

    await registerNext();
    registrations.shift()?.reject(new Error("listen refused"));
    await flush();

    expect(barrier.verdict()).toBe(false);
  });

  it("does not signal for a mount that was torn down before its listeners arrived", async () => {
    const barrier = watchBarrier();
    const { unmount } = render(<Harness />);
    await flush();
    unmount();

    while (registrations.length > 0) await registerNext();

    expect(barrier.verdict()).toBeUndefined();
    // …and what arrived late was unregistered on the spot.
    expect(unlistened).toEqual(CLOSE_EVENTS);
  });

  it("signals once, for the live mount, under StrictMode's double mount", async () => {
    const barrier = watchBarrier();
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    await flush();

    while (registrations.length > 0) await registerNext();

    expect(barrier.verdict()).toBe(true);
    // The torn-down first mount unregistered its three; the live one kept its own.
    expect(unlistened).toEqual(CLOSE_EVENTS);
    // One signal, so nothing for the barrier to report as a conflict.
    expect(conflicts).not.toHaveBeenCalled();
    expect(mockWindowCloseError).not.toHaveBeenCalled();
  });
});
