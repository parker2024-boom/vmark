// WI-TP1.1: exact assistant-only transcript parsing.
import { describe, expect, it } from "vitest";
import { appendTranscript, EMPTY_TRANSCRIPT, MAX_TRANSCRIPT_MESSAGES, parseTerminalTranscript, TRANSCRIPT_TEXT_LIMIT, type TranscriptTail } from "./terminalTranscript";
const line = (value: unknown) => JSON.stringify(value) + "\n";
describe("parseTerminalTranscript", () => {
  it("reads Claude assistant text and ignores tools, user text and partial lines", () => {
    const data = line({ type: "user", message: { role: "user", content: "secret" } }) +
      line({ type: "assistant", uuid: "a", message: { role: "assistant", content: [{ type: "text", text: "中文 | table" }, { type: "tool_use", name: "shell" }] } }) + '{"type":"assistant"';
    expect(parseTerminalTranscript(data)).toEqual([{ id: "a:0", text: "中文 | table" }]);
  });
  it("reads Codex output_text once and updates repeated identities", () => {
    const record = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", id: "m", content: [{ type: "output_text", text }] } });
    expect(parseTerminalTranscript(line(record("old")) + "bad\n" + line(record("new")))).toEqual([{ id: "m:0", text: "new" }]);
  });
  it("handles empty input and bounds retained messages", () => {
    expect(parseTerminalTranscript("")).toEqual([]);
    const data = Array.from({ length: 150 }, (_, i) => line({ type: "assistant", uuid: String(i), message: { role: "assistant", content: [{ type: "text", text: String(i) }] } })).join("");
    expect(parseTerminalTranscript(data)).toHaveLength(100);
    expect(parseTerminalTranscript(data)[0].text).toBe("50");
  });
});
// Preserve repeated legitimate replies when Codex does not supply a message id.
it("uses event timestamps to preserve repeated assistant replies", () => {
  const record = (timestamp: string) => ({ timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } });
  expect(parseTerminalTranscript(line(record("first")) + line(record("second")))).toHaveLength(2);
});

// WI-RA7C.6 — following by delta: each batch of records is decoded once and
// merged into what is held, instead of the whole tail being decoded again.
describe("appendTranscript", () => {
  const assistant = (id: string | undefined, text: string) =>
    ({ type: "assistant", ...(id ? { uuid: id } : {}), message: { role: "assistant", content: [{ type: "text", text }] } });
  const anonymous = (text: string) =>
    ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
  const texts = (tail: TranscriptTail) => tail.messages.map(message => message.text);

  it("holds the same messages as decoding the whole transcript at once", () => {
    const records = Array.from({ length: 30 }, (_, i) => line(i % 3 === 0 ? { type: "user", message: { role: "user", content: "q" } } : assistant(`m${i}`, `reply ${i}`)));
    const whole = parseTerminalTranscript(records.join(""));
    for (const chunk of [1, 4, 7, 30]) {
      let tail = EMPTY_TRANSCRIPT;
      for (let at = 0; at < records.length; at += chunk) tail = appendTranscript(tail, records.slice(at, at + chunk).join(""));
      expect(tail.messages).toEqual(whole);
      expect(tail.lines).toBe(30);
    }
  });
  it("names an id-less record by its line in the whole transcript, not in the delta", () => {
    expect(parseTerminalTranscript(line(anonymous("Done")), 41)).toEqual([{ id: "41:0", text: "Done" }]);
    let tail = appendTranscript(EMPTY_TRANSCRIPT, line(anonymous("Done")) + line({ type: "user" }));
    tail = appendTranscript(tail, line(anonymous("Done")));
    expect(tail.messages).toEqual([{ id: "0:0", text: "Done" }, { id: "2:0", text: "Done" }]);
  });
  it("replaces a repeated identity where it stands", () => {
    let tail = appendTranscript(EMPTY_TRANSCRIPT, line(assistant("a", "draft")) + line(assistant("b", "second")));
    tail = appendTranscript(tail, line(assistant("a", "final")));
    expect(tail.messages).toEqual([{ id: "a:0", text: "final" }, { id: "b:0", text: "second" }]);
  });
  it("returns what it was given when a delta carries nothing new", () => {
    const held = appendTranscript(EMPTY_TRANSCRIPT, line(assistant("a", "one")));
    expect(appendTranscript(held, "")).toBe(held);
    const afterNoise = appendTranscript(held, line({ type: "user" }) + "not json\n");
    expect(afterNoise.messages).toBe(held.messages);
    expect(afterNoise.lines).toBe(3);
  });
  it("leaves an incomplete final record for the delta that completes it", () => {
    const record = line(assistant("a", "中文 👩‍👩‍👧‍👦"));
    const tail = appendTranscript(EMPTY_TRANSCRIPT, record.slice(0, 20));
    expect(tail).toBe(EMPTY_TRANSCRIPT);
    expect(texts(appendTranscript(tail, record))).toEqual(["中文 👩‍👩‍👧‍👦"]);
  });
  it("keeps the newest messages within the count bound", () => {
    let tail = EMPTY_TRANSCRIPT;
    for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES + 25; i += 1) tail = appendTranscript(tail, line(assistant(`m${i}`, String(i))));
    expect(tail.messages).toHaveLength(MAX_TRANSCRIPT_MESSAGES);
    expect(texts(tail)[0]).toBe("25");
    expect(texts(tail).at(-1)).toBe(String(MAX_TRANSCRIPT_MESSAGES + 24));
  });
  it("keeps the newest messages within the text bound, and always the newest one", () => {
    const big = "x".repeat(100_000);
    let tail = EMPTY_TRANSCRIPT;
    for (let i = 0; i < 40; i += 1) tail = appendTranscript(tail, line(assistant(`m${i}`, big)));
    const held = tail.messages.reduce((sum, message) => sum + message.text.length, 0);
    expect(held).toBeLessThanOrEqual(TRANSCRIPT_TEXT_LIMIT);
    expect(tail.messages.at(-1)?.id).toBe("m39:0");
    expect(tail.messages.length).toBe(Math.floor(TRANSCRIPT_TEXT_LIMIT / big.length));
  });
});
