// @vitest-environment node
// WI-RA17D.6 — the browser automation lease's STATE lives in src/stores; its
// transitions (and the cancellers they fire) stay in services/browser/lease.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { resetBrowserLeaseStore, useBrowserLeaseStore } from "./browserLeaseStore";

beforeEach(resetBrowserLeaseStore);

describe("browserLeaseStore", () => {
  it("starts with no lease and no in-flight canceller", () => {
    expect(useBrowserLeaseStore.getState()).toEqual({ leases: {}, inflightCancel: {} });
  });

  it("holds data only — every transition is the lease service's", () => {
    const state = useBrowserLeaseStore.getState() as unknown as Record<string, unknown>;
    const functions = Object.keys(state).filter((key) => typeof state[key] === "function");
    expect(functions).toEqual([]);
  });

  it("reset drops every tab's record", () => {
    useBrowserLeaseStore.setState({
      leases: { "browser-1": { holder: "ai", epoch: 3 } },
      inflightCancel: { "browser-1": () => {} },
    });
    resetBrowserLeaseStore();
    expect(useBrowserLeaseStore.getState()).toEqual({ leases: {}, inflightCancel: {} });
  });
});
