// @vitest-environment node
// Round 3, #71 — the pieces of wait_for on their own: request validation, the
// mirror-answered URL poll, and the deadline-raced eval poll. The tab store is real;
// the eval is a function the test supplies, so no driver mock decides the timing.
// The clock is fake: every deadline and poll interval is moved explicitly, so a
// timeout lands at exactly its budget and no assertion depends on machine load.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/persistence/workspaceStorage", () => ({ getCurrentWindowLabel: () => "main" }));

import { useTabStore } from "@/stores/tabStore";
import { MAX_WAIT_MS, type BrowserTarget } from "@/services/mcpBridge/v2/browserHelpers";
import { readOperationArgsChecked } from "@/services/mcpBridge/v2/readOperationArgs";
import {
  pollScript,
  pollUrl,
  readWaitRequest,
  type PollContext,
} from "@/services/mcpBridge/v2/browserWaitForPoll";

/** Parse as the handler does: from the request's checked payload read. */
const readWait = (args: Record<string, unknown>) =>
  readWaitRequest(readOperationArgsChecked("vmark.browser.wait_for", args));

const SITE = "https://x.example.com/start?token=1#frag";
function seed(): string {
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  const id = useTabStore.getState().createBrowserTab("main", SITE, "X", "ai-sandbox");
  useTabStore.getState().updateBrowserTab(id, { generation: 1 });
  return id;
}
const allow = () => Promise.resolve(true);
function ctx(tabId: string, budgetMs: number, guard: PollContext["guard"] = allow): PollContext {
  return { tabId, deadline: Date.now() + budgetMs, guard, intervalMs: 5 };
}
const matched = (ref?: string) => Promise.resolve(JSON.stringify(ref ? { matched: true, ref } : { matched: true }));
const unmatched = () => Promise.resolve(JSON.stringify({ matched: false }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Track whether a poll has answered, without awaiting it. */
function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  void promise.finally(() => {
    done = true;
  }).catch(() => undefined);
  return { promise, settled: () => done };
}

describe("readWaitRequest", () => {
  it("defaults the timeout to the single wait budget and refuses one outside it", () => {
    expect(readWait({ text: "Done" })).toEqual({
      ok: true,
      request: { timeoutMs: MAX_WAIT_MS, mode: { kind: "script", condition: { text: "Done" } } },
    });
    for (const timeoutMs of [0, -1, 1.5, MAX_WAIT_MS + 1, "5000", NaN]) {
      expect(readWait({ text: "Done", timeoutMs })).toEqual({ ok: false, error: "INVALID_TIMEOUT" });
    }
  });

  it("accepts exactly one condition and maps each to its mode", () => {
    expect(readWait({ ref: "e2" }).ok && readWait({ ref: "e2" })).toMatchObject({
      request: { mode: { kind: "script", condition: { ref: "e2" } } },
    });
    expect(readWait({ role: "heading", name: "Done" })).toMatchObject({
      request: { mode: { kind: "script", condition: { role: "heading", name: "Done" } } },
    });
    expect(readWait({ role: "heading" })).toMatchObject({
      request: { mode: { kind: "script", condition: { role: "heading" } } },
    });
    expect(readWait({ urlContains: "/orders" })).toMatchObject({
      request: { mode: { kind: "url", needle: "/orders" } },
    });
  });

  it("refuses zero conditions, two conditions, and blank ones that count as absent", () => {
    const error = "wait_for needs exactly one of: ref, role (+optional name), text, or urlContains";
    expect(readWait({})).toEqual({ ok: false, error });
    expect(readWait({ text: "a", role: "button" })).toEqual({ ok: false, error });
    expect(readWait({ ref: "  ", text: "" })).toEqual({ ok: false, error });
    // A name alone is not a condition — it qualifies a role.
    expect(readWait({ name: "Done" })).toEqual({ ok: false, error });
  });

  it("refuses a urlContains needle that can never match the redacted url (A-06)", () => {
    for (const needle of ["?token=", "#frag", "/a?b"]) {
      const out = readWait({ urlContains: needle });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain("redacted URL");
    }
  });

  it("checks the timeout before the condition", () => {
    expect(readWait({ timeoutMs: 0 })).toEqual({ ok: false, error: "INVALID_TIMEOUT" });
  });
});

describe("pollUrl", () => {
  it("matches at once against the REDACTED url and reports that url", async () => {
    const id = seed();
    expect(await pollUrl(ctx(id, 1000), "/start")).toEqual({ kind: "matched", url: "https://x.example.com/start" });
  });

  it("matches once a navigation lands mid-wait", async () => {
    const id = seed();
    const wait = track(pollUrl(ctx(id, 2000), "/orders/done"));
    await vi.advanceTimersByTimeAsync(20);
    expect(wait.settled()).toBe(false);
    useTabStore.getState().updateBrowserTab(id, { url: "https://x.example.com/orders/done" });
    await vi.advanceTimersByTimeAsync(5);
    expect(await wait.promise).toEqual({
      kind: "matched",
      url: "https://x.example.com/orders/done",
    });
  });

  it("times out with the url it last saw", async () => {
    const id = seed();
    const wait = track(pollUrl(ctx(id, 15), "/never"));
    await vi.advanceTimersByTimeAsync(14);
    expect(wait.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.settled()).toBe(true);
    expect(await wait.promise).toEqual({ kind: "timeout", url: "https://x.example.com/start" });
  });

  it("reports a tab that left the store, and stops when the guard refuses", async () => {
    expect(await pollUrl(ctx("tab-gone", 100), "/x")).toEqual({ kind: "tab-gone" });
    const id = seed();
    const guard = vi.fn(async () => false);
    expect(await pollUrl(ctx(id, 100, guard), "/start")).toEqual({ kind: "aborted" });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ tabId: id, generation: 1 }));
  });
});

describe("pollScript", () => {
  it("resolves matched (with the ref) as soon as one poll says so", async () => {
    const id = seed();
    const evaluate = vi.fn<(tab: BrowserTarget) => Promise<string>>(() => matched("e2"));
    expect(await pollScript(ctx(id, 1000), evaluate)).toEqual({
      kind: "matched",
      url: "https://x.example.com/start",
      ref: "e2",
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ tabId: id, generation: 1 }));
  });

  it("polls until the condition holds, re-resolving the tab each round", async () => {
    const id = seed();
    const evaluate = vi.fn<(tab: BrowserTarget) => Promise<string>>().mockImplementationOnce(unmatched).mockImplementationOnce(() => matched());
    const wait = track(pollScript(ctx(id, 2000), evaluate));
    // The second round sees the generation the mirror advanced to meanwhile.
    useTabStore.getState().updateBrowserTab(id, { generation: 2 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await wait.promise).toEqual({ kind: "matched", url: "https://x.example.com/start" });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0][0].generation).toBe(1);
    expect(evaluate.mock.calls[1][0].generation).toBe(2);
  });

  it("samples more than once inside a short budget — no floor turns a short wait into one poll", async () => {
    const id = seed();
    const evaluate = vi.fn<(tab: BrowserTarget) => Promise<string>>(unmatched);
    const wait = track(pollScript(ctx(id, 60), evaluate));
    await vi.advanceTimersByTimeAsync(60);
    expect(await wait.promise).toMatchObject({ kind: "timeout" });
    expect(evaluate.mock.calls.length).toBeGreaterThan(1);
  });

  it("abandons a poll that outlives the deadline and reports the timeout on time, swallowing its late rejection", async () => {
    const id = seed();
    let rejectLate: (e: unknown) => void = () => {};
    const evaluate = () => new Promise<string>((_, reject) => { rejectLate = reject; });
    const wait = track(pollScript(ctx(id, 30), evaluate));
    // On time: still waiting a millisecond before the deadline, answered at it.
    await vi.advanceTimersByTimeAsync(29);
    expect(wait.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.settled()).toBe(true);
    expect(await wait.promise).toEqual({ kind: "timeout", url: "https://x.example.com/start" });
    // Nothing is listening any more: a late rejection must not become an
    // unhandled one (Vitest fails the run on any unhandled rejection).
    rejectLate(new Error("EVAL_TIMEOUT: late"));
  });

  it("propagates a driver rejection that arrives in time, so the model sees its token", async () => {
    const id = seed();
    const refusal = { code: "conflict", message: "stale", detail: { mcpCode: "STALE_COMMAND" } };
    await expect(pollScript(ctx(id, 1000), () => Promise.reject(refusal))).rejects.toBe(refusal);
  });

  it("reports a tab that left the store and stops without evaluating when the guard refuses", async () => {
    expect(await pollScript(ctx("tab-gone", 100), () => matched())).toEqual({ kind: "tab-gone" });
    const id = seed();
    const evaluate = vi.fn<(tab: BrowserTarget) => Promise<string>>(() => matched());
    expect(await pollScript(ctx(id, 100, async () => false), evaluate)).toEqual({ kind: "aborted" });
    expect(evaluate).not.toHaveBeenCalled();
  });
});
