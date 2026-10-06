/** Assistant-only JSONL transcript decoding. Complete lines only; bounded history.
 * A follower holds decoded messages, never the raw text: each delta is parsed
 * once (`appendTranscript`) and merged by id, so a poll costs what it brought.
 * @module utils/terminalTranscript */

export interface TranscriptMessage { id: string; text: string }
/** What a follower holds: the messages, and how many complete lines produced them. */
export interface TranscriptTail { messages: TranscriptMessage[]; lines: number }
export const EMPTY_TRANSCRIPT: TranscriptTail = { messages: [], lines: 0 };
/** Messages kept, newest last. */
export const MAX_TRANSCRIPT_MESSAGES = 100;
/** Characters of one message kept. */
const MAX_MESSAGE_TEXT = 100_000;
/** Characters of message text kept in total — the bound the backend puts on a fresh tail. */
export const TRANSCRIPT_TEXT_LIMIT = 2 * 1024 * 1024;

/** Decode the complete lines of `data`. `lineBase` is how many lines preceded it in the
 * transcript: a record with no id of its own is named by its line number, which must count
 * from the start of the transcript for two deltas not to hand out the same name. */
export function parseTerminalTranscript(data: string, lineBase = 0): TranscriptMessage[] {
  const messages = new Map<string, TranscriptMessage>();
  const lines = data.split("\n");
  lines.pop(); // A writer may still be appending the final record.
  for (const [lineIndex, line] of lines.entries()) {
    try {
      const value = JSON.parse(line);
      const message = value.type === "assistant" ? value.message :
        value.type === "response_item" && value.payload?.type === "message" ? value.payload : null;
      if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
      message.content.forEach((part: { type?: string; text?: unknown }, index: number) => {
        if (!["text", "output_text"].includes(part.type ?? "") || typeof part.text !== "string") return;
        const id = `${value.uuid ?? message.id ?? value.timestamp ?? lineBase + lineIndex}:${index}`;
        messages.set(id, { id, text: part.text.slice(0, MAX_MESSAGE_TEXT) });
      });
    } catch { /* Malformed or non-message records do not interrupt following. */ }
  }
  return [...messages.values()].slice(-MAX_TRANSCRIPT_MESSAGES);
}

/** `held` plus the records in `data`: a repeated id replaces its message in place, and the
 * oldest messages beyond the count and text bounds are dropped (the newest always stays). */
export function appendTranscript(held: TranscriptTail, data: string): TranscriptTail {
  const lines = held.lines + countLines(data);
  const parsed = parseTerminalTranscript(data, held.lines);
  if (parsed.length === 0) return lines === held.lines ? held : { messages: held.messages, lines };
  const merged = new Map(held.messages.map(message => [message.id, message]));
  for (const message of parsed) merged.set(message.id, message);
  const messages = [...merged.values()].slice(-MAX_TRANSCRIPT_MESSAGES);
  let text = 0;
  let start = messages.length;
  while (start > 0 && (start === messages.length || text + messages[start - 1].text.length <= TRANSCRIPT_TEXT_LIMIT)) {
    start -= 1;
    text += messages[start].text.length;
  }
  return { messages: messages.slice(start), lines };
}

function countLines(data: string): number {
  let count = 0;
  for (let at = data.indexOf("\n"); at !== -1; at = data.indexOf("\n", at + 1)) count += 1;
  return count;
}
