// @vitest-environment jsdom
// WI-RA7C.8 — a document window announces itself ready only once its close and
// quit listeners are registered, not merely its menu listener. Rust sends
// `app:quit-requested` to a ready window exactly once; in the gap between the
// two registrations that request went to nobody and quit waited ten seconds
// for a retry.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockWindowContextError = vi.fn();
vi.mock("@/utils/debug", () => ({
  windowContextError: (...a: unknown[]) => mockWindowContextError(...a),
  windowCloseError: vi.fn(),
  menuError: vi.fn(),
}));

import { READY_ATTRIBUTE, useWindowReady } from "./useWindowReady";
import {
  signalMenuCommandsMounted,
  resetMenuCommandsForTest,
} from "@/services/commands/menuCommandsReady";
import {
  signalCloseListenersMounted,
  resetCloseListenersForTest,
} from "@/services/windowClose/closeListenersReady";

beforeEach(() => {
  vi.useFakeTimers();
  mockWindowContextError.mockReset();
  resetMenuCommandsForTest();
  resetCloseListenersForTest();
  document.documentElement.removeAttribute(READY_ATTRIBUTE);
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute(READY_ATTRIBUTE);
});

const readyAttr = () => document.documentElement.getAttribute(READY_ATTRIBUTE);
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const signal = (which: (ok: boolean) => void, ok = true) =>
  act(async () => { which(ok); await vi.advanceTimersByTimeAsync(0); });

function startHandshake(label: string) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useWindowReady());
  act(() => result.current.markReady({ label, emit }));
  return emit;
}

describe("useWindowReady — close listeners", () => {
  it("does not announce a document window on its menu listener alone", async () => {
    const emit = startHandshake("main");

    await signal(signalMenuCommandsMounted);
    await settle(4_000);
    expect(emit).not.toHaveBeenCalled();
    expect(readyAttr()).toBeNull();

    await signal(signalCloseListenersMounted);
    expect(emit).toHaveBeenCalledWith("ready", "main");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(readyAttr()).toBe("true");
    expect(mockWindowContextError).not.toHaveBeenCalled();
  });

  it("does not announce on its close listeners alone either", async () => {
    const emit = startHandshake("doc-2");

    await signal(signalCloseListenersMounted);
    await settle(4_000);
    expect(emit).not.toHaveBeenCalled();

    await signal(signalMenuCommandsMounted);
    expect(emit).toHaveBeenCalledWith("ready", "doc-2");
  });

  it("announces at once when both were registered before the handshake asked", async () => {
    signalMenuCommandsMounted(true);
    signalCloseListenersMounted(true);

    const emit = startHandshake("main");
    await settle();

    expect(emit).toHaveBeenCalledWith("ready", "main");
  });

  it("announces anyway, loudly, when the close listeners never register", async () => {
    // A window that never reports ready is unusable — menus queue forever and a
    // quit waits on it — so the budget expires into an announcement. Not
    // quietly: this is the state in which a quit request can still be lost.
    const emit = startHandshake("main");
    await signal(signalMenuCommandsMounted);

    await settle(5_000);

    expect(emit).toHaveBeenCalledWith("ready", "main");
    expect(mockWindowContextError).toHaveBeenCalledWith(
      expect.stringContaining("close listeners did not register"),
    );
    expect(mockWindowContextError).not.toHaveBeenCalledWith(
      expect.stringContaining("menu commands"),
    );
  });

  it("announces anyway, loudly, when registering the close listeners failed", async () => {
    const emit = startHandshake("main");
    await signal(signalMenuCommandsMounted);

    await signal(signalCloseListenersMounted, false);

    expect(emit).toHaveBeenCalledWith("ready", "main");
    expect(mockWindowContextError).toHaveBeenCalledWith(
      expect.stringContaining("close listeners did not register"),
    );
  });

  it("does not make a settings window wait: it registers no close listeners", async () => {
    const emit = startHandshake("settings");

    await settle(200);

    expect(emit).toHaveBeenCalledWith("ready", "settings");
    expect(mockWindowContextError).not.toHaveBeenCalled();
  });
});
