// WI-TP1.2: polling is disabled when hidden; late reads cannot cross sessions.
// WI-RA6.5 — the hook follows a transcript by delta: it echoes the cursor the
//   backend returned, appends what arrived, and starts over on a reset.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_TAIL_LIMIT, useTerminalTranscript } from "./useTerminalTranscript";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), log: vi.fn(), tokens: new Map<string, string>() }));
vi.mock("@/utils/debug", () => ({ terminalLog: mocks.log }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/services/terminal/transcriptBinding", () => ({ transcriptToken: (id: string) => mocks.tokens.get(id) ?? id }));
beforeEach(() => { vi.useFakeTimers(); mocks.invoke.mockReset(); mocks.log.mockClear(); mocks.tokens.clear(); });
afterEach(() => vi.useRealTimers());

/** One assistant record, as a complete JSONL line. */
function record(id: string, text: string): string {
  return JSON.stringify({ type: "assistant", uuid: id, message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
}
/** What the backend answers: the bytes since the cursor it was given, or a fresh tail. */
function delta(offset: number, data: string, reset = false) {
  return { cursor: { identity: "file-1", offset, size: offset, modified: "1" }, reset, data };
}
/** Answer successive reads with `responses`, then keep reporting "nothing new". */
function answerWith(...responses: unknown[]) {
  const last = responses[responses.length - 1] as { cursor?: unknown } | null;
  const idle = last && last.cursor ? { cursor: last.cursor, reset: false, data: "" } : null;
  let call = 0;
  mocks.invoke.mockImplementation(() => {
    const response = call < responses.length ? responses[call] : idle;
    call += 1;
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
const texts = (messages: { text: string }[]) => messages.map(message => message.text);
const cursorOf = (call: number) => (mocks.invoke.mock.calls[call]?.[1] as { cursor: unknown }).cursor;

describe("useTerminalTranscript", () => {
  it("does no IO when disabled", () => {
    mocks.invoke.mockClear();
    renderHook(() => useTerminalTranscript("a", false));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("drops late responses when the session changes", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mocks.invoke.mockImplementation((command: string, args?: { token?: string }) => {
      if (command === "terminal_transcript_configure") return Promise.resolve();
      if (args?.token === "a") return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve(delta(10, record("b", "second"), true));
    });
    const { result, rerender, unmount } = renderHook(({ id }) => useTerminalTranscript(id, true), { initialProps: { id: "a" } });
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_transcript_read", expect.objectContaining({ token: "a" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    rerender({ id: "b" });
    await act(async () => {});
    expect(result.current.messages[0]?.text).toBe("second");
    await act(async () => { resolveFirst(delta(10, record("a", "stale"), true)); });
    expect(texts(result.current.messages)).toEqual(["second"]);
    unmount();
  });
  it("logs a persistent read failure once, not on every poll", async () => {
    mocks.invoke.mockRejectedValue(new Error("denied"));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(mocks.invoke.mock.calls.length).toBeGreaterThan(2);
    expect(result.current.failed).toBe(true);
    expect(mocks.log).toHaveBeenCalledTimes(1);
    unmount();
  });
  it("reports loaded only once a snapshot for the current binding has arrived", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    expect(result.current.loaded).toBe(false);
    await act(async () => { resolve(null); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.messages).toEqual([]);
    unmount();
  });
  it("reports loaded for a transcript that exists but holds nothing yet", async () => {
    answerWith(delta(0, "", true));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    expect(result.current).toMatchObject({ loaded: true, failed: false, messages: [] });
    unmount();
  });
  it("sends no cursor on the first read and echoes the returned one afterwards", async () => {
    const first = delta(40, record("a", "one"), true);
    answerWith(first, delta(80, record("b", "two")));
    const { unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "terminal_transcript_read", { token: "a", cursor: null });
    await tick();
    expect(cursorOf(1)).toEqual(first.cursor);
    await tick();
    expect(cursorOf(2)).toEqual({ ...first.cursor, offset: 80, size: 80 });
    unmount();
  });
  it("appends what arrived to what it already holds", async () => {
    answerWith(delta(40, record("a", "one"), true), delta(80, record("b", "two")), delta(120, record("c", "three")));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    expect(texts(result.current.messages)).toEqual(["one"]);
    await tick();
    expect(texts(result.current.messages)).toEqual(["one", "two"]);
    await tick();
    expect(texts(result.current.messages)).toEqual(["one", "two", "three"]);
    unmount();
  });
  it("keeps the same messages when nothing was appended", async () => {
    answerWith(delta(40, record("a", "one"), true));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    const held = result.current.messages;
    await tick();
    await tick();
    expect(mocks.invoke.mock.calls.length).toBeGreaterThan(2);
    expect(result.current.messages).toBe(held);
    unmount();
  });
  it("starts over when the backend reports a reset (truncated or replaced file)", async () => {
    answerWith(delta(40, record("a", "one"), true), delta(80, record("b", "two")), delta(30, record("z", "fresh"), true));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    await tick();
    expect(texts(result.current.messages)).toEqual(["one", "two"]);
    await tick();
    expect(texts(result.current.messages)).toEqual(["fresh"]);
    unmount();
  });
  it("empties the transcript on a reset that carries nothing", async () => {
    answerWith(delta(40, record("a", "one"), true), delta(0, "", true));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    await tick();
    expect(result.current).toMatchObject({ loaded: true, messages: [] });
    unmount();
  });
  it("keeps multi-byte text intact across deltas", async () => {
    const [cjk, emoji, accent] = ["你好，世界", "👩‍👩‍👧‍👦 🏳️‍🌈", "café — naïve"];
    answerWith(delta(40, record("a", cjk), true), delta(80, record("b", emoji)), delta(120, record("c", accent)));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    await tick();
    await tick();
    expect(texts(result.current.messages)).toEqual([cjk, emoji, accent]);
    unmount();
  });
  it("starts from a fresh tail after a failed read", async () => {
    answerWith(delta(40, record("a", "one"), true), new Error("denied"), delta(40, record("a", "again"), true));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    await tick();
    expect(result.current).toMatchObject({ failed: true, messages: [] });
    await tick();
    expect(cursorOf(2)).toBeNull();
    expect(result.current).toMatchObject({ failed: false, loaded: true });
    expect(texts(result.current.messages)).toEqual(["again"]);
    unmount();
  });
  it("forgets the cursor when the binding goes away", async () => {
    answerWith(delta(40, record("a", "one"), true), null, delta(40, record("b", "new"), true));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    await tick();
    expect(result.current.messages).toEqual([]);
    await tick();
    expect(cursorOf(2)).toBeNull();
    expect(texts(result.current.messages)).toEqual(["new"]);
    unmount();
  });
  it("starts over when the session's shell gets a new token", async () => {
    answerWith(delta(40, record("a", "one"), true), delta(40, record("b", "next shell"), true));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    mocks.tokens.set("a", "token-2");
    await tick();
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "terminal_transcript_read", { token: "token-2", cursor: null });
    expect(texts(result.current.messages)).toEqual(["next shell"]);
    unmount();
  });
  it("holds a bounded tail made of whole records", async () => {
    const body = "x".repeat(50_000);
    const line = (index: number) => record(`r${index}`, `${index}:${body}`);
    const perDelta = 10;
    const deltas = Math.ceil((TRANSCRIPT_TAIL_LIMIT * 1.5) / (line(0).length * perDelta));
    const responses = Array.from({ length: deltas }, (_, d) =>
      delta((d + 1) * 1000, Array.from({ length: perDelta }, (_, i) => line(d * perDelta + i)).join(""), d === 0));
    answerWith(...responses);
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    for (let d = 1; d < deltas; d += 1) await tick();
    const held = texts(result.current.messages);
    const total = deltas * perDelta;
    // The newest records, in order, each complete — and not all of them.
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThanOrEqual(Math.floor(TRANSCRIPT_TAIL_LIMIT / line(0).length));
    expect(held).toEqual(Array.from({ length: held.length }, (_, i) => `${total - held.length + i}:${body}`));
    unmount();
  });
  // WI-RA7C.6 — a poll parses the records it brought, not everything held. The
  // hook used to keep the raw tail and re-parse all of it on every delta, so a
  // streaming CLI cost one parse per held record per second.
  it("parses each record once, however many polls follow it", async () => {
    const polls = 12;
    answerWith(...Array.from({ length: polls }, (_, i) => delta((i + 1) * 40, record(`r${i}`, `text ${i}`), i === 0)));
    const parse = vi.spyOn(JSON, "parse");
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    for (let i = 1; i < polls; i += 1) await tick();
    const parsedRecords = parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes('"assistant"')).length;
    parse.mockRestore();
    expect(texts(result.current.messages)).toEqual(Array.from({ length: polls }, (_, i) => `text ${i}`));
    expect(parsedRecords).toBe(polls);
    unmount();
  });
  it("keeps id-less records from different polls apart", async () => {
    // Codex writes messages with no id; the line number stands in, and it has
    // to count from the start of the transcript, not of each delta.
    const anonymous = (text: string) =>
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n";
    answerWith(delta(40, anonymous("Done"), true), delta(80, anonymous("Done")), delta(120, anonymous("Done")));
    const { result, unmount } = renderHook(() => useTerminalTranscript("a", true));
    await act(async () => {});
    await tick();
    await tick();
    expect(texts(result.current.messages)).toEqual(["Done", "Done", "Done"]);
    expect(new Set(result.current.messages.map(message => message.id)).size).toBe(3);
    unmount();
  });
});
