// @vitest-environment node
// WI-1.9 / R11 / WI-NB5.1 — automation lease: AI vs human arbitration.
// The epoch is the TAKEOVER clock: it moves only when authority changes
// (reclaim, release) — never on navigation, so a workflow's own navigate
// steps cannot self-cancel the run (Codex review C3). Per-page staleness
// is the driver's navigation-generation check, a different clock.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { browserLease } from "./lease";
import { useBrowserLeaseStore } from "@/stores/browserLeaseStore";

const TAB = "browser-1";

function reset() {
  useBrowserLeaseStore.setState({ leases: {}, inflightCancel: {} });
}

beforeEach(reset);

describe("acquireForAi", () => {
  it("grants the lease on a free tab (holder=ai, epoch starts at 0)", () => {
    expect(browserLease.acquireForAi(TAB)).toBe(true);
    expect(browserLease.currentHolder(TAB)).toBe("ai");
    expect(browserLease.epochOf(TAB)).toBe(0);
  });

  it("is idempotent when the AI already holds the lease", () => {
    browserLease.acquireForAi(TAB);
    expect(browserLease.acquireForAi(TAB)).toBe(true);
    expect(browserLease.currentHolder(TAB)).toBe("ai");
  });

  it("refuses while a human hold is fresh (human always wins over the interrupted run)", () => {
    browserLease.acquireForAi(TAB);
    browserLease.reclaimForHuman(TAB);
    expect(browserLease.acquireForAi(TAB)).toBe(false);
    expect(browserLease.currentHolder(TAB)).toBe("human");
  });

  // Audit 2026-09-03 W-04: a human hold used to be PERMANENT — nothing released it,
  // so one accidental scroll refused every later workflow_run on the tab until it
  // was closed. The hold is the interruption of an AI tenure; the run service
  // releases it when the interrupted run ends, and the AI may acquire again.
  it("succeeds again once the human hold is released (a hold is not permanent)", () => {
    browserLease.acquireForAi(TAB);
    browserLease.reclaimForHuman(TAB);
    browserLease.release(TAB, "human");
    expect(browserLease.currentHolder(TAB)).toBeNull();
    expect(browserLease.acquireForAi(TAB)).toBe(true);
    expect(browserLease.currentHolder(TAB)).toBe("ai");
  });
});

describe("reclaimForHuman", () => {
  it("always takes the lease, bumps the epoch, and cancels the AI's in-flight step", () => {
    browserLease.acquireForAi(TAB);
    const cancel = vi.fn();
    browserLease.setInflightCancel(TAB, cancel);
    const genBefore = browserLease.epochOf(TAB);

    browserLease.reclaimForHuman(TAB);

    expect(browserLease.currentHolder(TAB)).toBe("human");
    expect(browserLease.epochOf(TAB)).toBe(genBefore + 1);
    expect(cancel).toHaveBeenCalledTimes(1);
    // The canceller is cleared after firing (no double-cancel on a later reclaim).
    browserLease.reclaimForHuman(TAB);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a tab the AI does not hold — ordinary browsing never creates a human hold (W-04)", () => {
    expect(() => browserLease.reclaimForHuman(TAB)).not.toThrow();
    expect(browserLease.currentHolder(TAB)).toBeNull();
    expect(browserLease.epochOf(TAB)).toBe(0);
    // …so a later run is not locked out by a scroll that interrupted nothing.
    expect(browserLease.acquireForAi(TAB)).toBe(true);
  });

  it("is a no-op while the human already holds it (no double bump, no double cancel)", () => {
    browserLease.acquireForAi(TAB);
    browserLease.reclaimForHuman(TAB);
    const epoch = browserLease.epochOf(TAB);
    browserLease.reclaimForHuman(TAB);
    expect(browserLease.epochOf(TAB)).toBe(epoch);
    expect(browserLease.currentHolder(TAB)).toBe("human");
  });
});

describe("validate (driver command envelope)", () => {
  it("accepts an AI command tagged with the current holder and generation", () => {
    browserLease.acquireForAi(TAB);
    const gen = browserLease.epochOf(TAB);
    expect(browserLease.validate(TAB, "ai", gen)).toBe("ok");
  });

  it("rejects an AI command as lease-lost after a human reclaim", () => {
    browserLease.acquireForAi(TAB);
    const staleGen = browserLease.epochOf(TAB);
    browserLease.reclaimForHuman(TAB);
    // Lease holder is now human → an "ai"-tagged command is lease-lost, not stale.
    expect(browserLease.validate(TAB, "ai", staleGen)).toBe("lease-lost");
  });

  it("rejects an AI command as stale after a reclaim/release cycle moved the epoch", () => {
    browserLease.acquireForAi(TAB);
    const oldGen = browserLease.epochOf(TAB);
    browserLease.reclaimForHuman(TAB);
    browserLease.release(TAB, "human");
    browserLease.acquireForAi(TAB);
    expect(browserLease.validate(TAB, "ai", oldGen)).toBe("stale");
    // A command tagged with the CURRENT epoch is accepted again.
    const newEpoch = browserLease.epochOf(TAB);
    expect(browserLease.validate(TAB, "ai", newEpoch)).toBe("ok");
  });

  it("treats a command for an unknown tab as lease-lost", () => {
    expect(browserLease.validate("nope", "ai", 0)).toBe("lease-lost");
  });
});

describe("epoch semantics (WI-NB5.1)", () => {
  it("release bumps the epoch, so a pre-release envelope cannot validate after re-acquire", () => {
    browserLease.acquireForAi(TAB);
    const epoch = browserLease.epochOf(TAB);
    browserLease.release(TAB, "ai");
    browserLease.acquireForAi(TAB);
    expect(browserLease.validate(TAB, "ai", epoch)).toBe("stale");
    expect(browserLease.validate(TAB, "ai", browserLease.epochOf(TAB))).toBe("ok");
  });

  it("reclaim-then-release-then-reacquire never resurrects an old envelope", () => {
    browserLease.acquireForAi(TAB);
    const epoch = browserLease.epochOf(TAB);
    browserLease.reclaimForHuman(TAB);
    browserLease.release(TAB, "human");
    browserLease.acquireForAi(TAB);
    expect(browserLease.validate(TAB, "ai", epoch)).toBe("stale");
  });

  it("there is no navigation clock here: nothing but authority transitions moves the epoch", () => {
    browserLease.acquireForAi(TAB);
    const epoch = browserLease.epochOf(TAB);
    // Simulated long tenure: acquire is idempotent and moves nothing.
    browserLease.acquireForAi(TAB);
    expect(browserLease.epochOf(TAB)).toBe(epoch);
    expect((browserLease as unknown as Record<string, unknown>).bumpGeneration).toBeUndefined();
  });
});

describe("release", () => {
  it("releases the lease held by the given holder", () => {
    browserLease.acquireForAi(TAB);
    browserLease.release(TAB, "ai");
    expect(browserLease.currentHolder(TAB)).toBeNull();
  });

  it("is a no-op when released by a non-holder (does not steal the lease)", () => {
    browserLease.acquireForAi(TAB);
    browserLease.reclaimForHuman(TAB);
    browserLease.release(TAB, "ai");
    expect(browserLease.currentHolder(TAB)).toBe("human");
  });
});

describe("removeTab", () => {
  it("clears lease + inflight state for a closed tab", () => {
    browserLease.acquireForAi(TAB);
    browserLease.setInflightCancel(TAB, vi.fn());
    browserLease.removeTab(TAB);
    expect(browserLease.currentHolder(TAB)).toBeNull();
    expect(browserLease.epochOf(TAB)).toBe(0);
  });

  it("cancels the AI's in-flight step (never leave it running against a destroyed surface)", () => {
    browserLease.acquireForAi(TAB);
    const cancel = vi.fn();
    browserLease.setInflightCancel(TAB, cancel);
    browserLease.removeTab(TAB);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("in-flight canceller lifecycle", () => {
  it("release cancels and clears the in-flight step (no lease → no in-flight AI step)", () => {
    browserLease.acquireForAi(TAB);
    const cancel = vi.fn();
    browserLease.setInflightCancel(TAB, cancel);
    browserLease.release(TAB, "ai");
    expect(cancel).toHaveBeenCalledTimes(1);
    // Cleared: a later reclaim must not re-fire the same canceller.
    browserLease.reclaimForHuman(TAB);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("a refused release leaves the in-flight step alone", () => {
    browserLease.acquireForAi(TAB);
    browserLease.reclaimForHuman(TAB); // human holds
    const cancel = vi.fn();
    useBrowserLeaseStore.setState({ inflightCancel: { [TAB]: cancel } });
    browserLease.release(TAB, "ai"); // not the holder → no-op
    expect(cancel).not.toHaveBeenCalled();
  });

  it("refuses to register a canceller while the AI does not hold the lease, cancelling it at once", () => {
    // A registration that lands after a human reclaim would otherwise re-install
    // an operation the reclaim just cancelled (R11).
    browserLease.acquireForAi(TAB);
    browserLease.reclaimForHuman(TAB);
    const late = vi.fn();
    browserLease.setInflightCancel(TAB, late);
    expect(late).toHaveBeenCalledTimes(1); // rejected → cancelled immediately
    expect(useBrowserLeaseStore.getState().inflightCancel[TAB]).toBeUndefined();
  });

  it("replacing a canceller cancels the previous in-flight step (at most one per tab)", () => {
    browserLease.acquireForAi(TAB);
    const first = vi.fn();
    const second = vi.fn();
    browserLease.setInflightCancel(TAB, first);
    browserLease.setInflightCancel(TAB, second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    browserLease.reclaimForHuman(TAB);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("clearing the canceller (null) does not fire it — the step completed on its own", () => {
    browserLease.acquireForAi(TAB);
    const cancel = vi.fn();
    browserLease.setInflightCancel(TAB, cancel);
    browserLease.setInflightCancel(TAB, null);
    expect(cancel).not.toHaveBeenCalled();
    expect(useBrowserLeaseStore.getState().inflightCancel[TAB]).toBeUndefined();
  });
});

describe("a misbehaving canceller cannot block a lease transition", () => {
  it("human reclaim still lands when the canceller throws", () => {
    browserLease.acquireForAi(TAB);
    browserLease.setInflightCancel(TAB, () => {
      throw new Error("cancel exploded");
    });

    expect(() => browserLease.reclaimForHuman(TAB)).not.toThrow();
    expect(browserLease.currentHolder(TAB)).toBe("human");
    expect(browserLease.epochOf(TAB)).toBe(1);
    expect(useBrowserLeaseStore.getState().inflightCancel[TAB]).toBeUndefined();
  });

  it("a reclaim still lands (and bumps the epoch) when the canceller throws", () => {
    browserLease.acquireForAi(TAB);
    browserLease.setInflightCancel(TAB, () => {
      throw new Error("cancel exploded");
    });

    expect(() => browserLease.reclaimForHuman(TAB)).not.toThrow();
    expect(browserLease.epochOf(TAB)).toBe(1);
    expect(browserLease.currentHolder(TAB)).toBe("human");
  });

  it("a re-entrant canceller cannot resurrect the AI's lease or its in-flight step", () => {
    browserLease.acquireForAi(TAB);
    const reregistered = vi.fn();
    browserLease.setInflightCancel(TAB, () => {
      // The canceller re-enters the store: it must observe the COMMITTED
      // transition (human holds the lease), not overwrite it.
      browserLease.acquireForAi(TAB);
      browserLease.setInflightCancel(TAB, reregistered);
    });

    browserLease.reclaimForHuman(TAB);

    expect(browserLease.currentHolder(TAB)).toBe("human");
    expect(useBrowserLeaseStore.getState().inflightCancel[TAB]).toBeUndefined();
    expect(reregistered).toHaveBeenCalledTimes(1); // rejected → cancelled at once
  });
});
