// @vitest-environment node
// WI-NB5.1 — the lease's real event sources: native page input reclaims an
// AI-held tab, tab close clears lease state. These are the edges whose absence
// made lease.ts "a specification, not a control".
import { describe, it, expect, beforeEach, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(unlisten);
  },
}));

import { startBrowserLeaseWiring } from "@/services/browser/browserLeaseWiring";
import { browserLease } from "@/services/browser/lease";
import { useBrowserLeaseStore } from "@/stores/browserLeaseStore";
import { notifyTabRemoved } from "@/stores/tabRemovalBus";

const TAB = "browser-9";

beforeEach(() => {
  listeners.clear();
  unlisten.mockClear();
  useBrowserLeaseStore.setState({ leases: {}, inflightCancel: {} });
});

describe("startBrowserLeaseWiring", () => {
  it("native page input reclaims an AI-held tab and cancels its in-flight step", async () => {
    const stop = startBrowserLeaseWiring();
    await Promise.resolve(); // listen() registration settles
    browserLease.acquireForAi(TAB);
    const cancel = vi.fn();
    browserLease.setInflightCancel(TAB, cancel);

    listeners.get("browser://user-input")!({ payload: { tabId: TAB } });

    expect(browserLease.currentHolder(TAB)).toBe("human");
    expect(cancel).toHaveBeenCalledTimes(1);
    stop();
  });

  it("native input on a free tab is a no-op (no phantom human lease)", async () => {
    const stop = startBrowserLeaseWiring();
    await Promise.resolve();
    listeners.get("browser://user-input")!({ payload: { tabId: TAB } });
    expect(browserLease.currentHolder(TAB)).toBeNull();
    stop();
  });

  it("a malformed payload is ignored, never a throw", async () => {
    const stop = startBrowserLeaseWiring();
    await Promise.resolve();
    expect(() => listeners.get("browser://user-input")!({ payload: null })).not.toThrow();
    expect(() => listeners.get("browser://user-input")!({ payload: { tabId: 5 } })).not.toThrow();
    stop();
  });

  it("tab removal clears the lease and cancels in-flight work", () => {
    const stop = startBrowserLeaseWiring();
    browserLease.acquireForAi(TAB);
    const cancel = vi.fn();
    browserLease.setInflightCancel(TAB, cancel);

    notifyTabRemoved("main", TAB);

    expect(browserLease.currentHolder(TAB)).toBeNull();
    expect(browserLease.epochOf(TAB)).toBe(0); // state dropped entirely
    expect(cancel).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop() detaches both sources", async () => {
    const stop = startBrowserLeaseWiring();
    await Promise.resolve();
    stop();
    expect(unlisten).toHaveBeenCalled();
    browserLease.acquireForAi(TAB);
    notifyTabRemoved("main", TAB);
    expect(browserLease.currentHolder(TAB)).toBe("ai"); // no longer listening
  });
});
