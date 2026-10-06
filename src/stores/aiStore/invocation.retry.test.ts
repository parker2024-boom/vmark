// WI-RA19.3 — a failed invocation keeps the means to re-run it, and only that
// failure: Retry re-runs exactly the request that failed, never an older one,
// and a failure with nothing to re-run (provider validation, a refused cancel)
// offers no retry at all.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAiInvocationStore } from "./invocation";

const store = () => useAiInvocationStore.getState();

beforeEach(() => {
  store().cancel();
});

describe("invocation retry", () => {
  it("keeps the retry of the request that failed", () => {
    const retry = vi.fn();
    store().tryStart("r1");
    store().setError("boom", "r1", retry);
    expect(store().error).toBe("boom");
    expect(store().retry).toBe(retry);
  });

  it("retryFailed clears the error and re-runs the failed request once", () => {
    const retry = vi.fn();
    store().tryStart("r1");
    store().setError("boom", "r1", retry);

    store().retryFailed();

    expect(retry).toHaveBeenCalledOnce();
    expect(store().error).toBeNull();
    expect(store().retry).toBeNull();
    expect(store().hasActiveStatus).toBe(false);
  });

  it("a second retryFailed does not re-run the request again", () => {
    const retry = vi.fn();
    store().tryStart("r1");
    store().setError("boom", "r1", retry);
    store().retryFailed();
    store().retryFailed();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("an error with nothing to re-run offers no retry", () => {
    store().setError("no provider");
    expect(store().retry).toBeNull();
  });

  it("an unscoped error replaces an earlier request's retry rather than inheriting it", () => {
    const stale = vi.fn();
    store().tryStart("r1");
    store().setError("boom", "r1", stale);
    store().setError("cancel refused");
    expect(store().retry).toBeNull();
    store().retryFailed();
    expect(stale).not.toHaveBeenCalled();
  });

  it("a stale request's failure does not install its retry over a newer run", () => {
    const stale = vi.fn();
    store().tryStart("r1");
    store().cancel();
    store().tryStart("r2");
    store().setError("late", "r1", stale);
    expect(store().retry).toBeNull();
    expect(store().isRunning).toBe(true);
  });

  it.each([
    ["dismissError", () => store().dismissError()],
    ["cancel", () => store().cancel()],
    ["a new run starting", () => store().tryStart("r2")],
  ])("%s drops the retry", (_label, act) => {
    store().tryStart("r1");
    store().setError("boom", "r1", vi.fn());
    act();
    expect(store().retry).toBeNull();
  });

  it("a successful finish leaves no retry behind", () => {
    store().tryStart("r1");
    store().finish("r1");
    expect(store().retry).toBeNull();
  });
});
