/** Automatic, non-overlapping transcript following. Hidden/disabled panels do no reads.
 * Each read hands back the cursor the previous one returned and receives only the complete
 * records appended since. `reset` marks a fresh tail (first read, truncated or replaced file),
 * which replaces what is held. What is held is the decoded messages, bounded, never the raw
 * text: each delta is parsed once and merged, so a poll costs what it brought.
 * `loaded` turns true once a snapshot for the current binding has arrived (even an empty one).
 * @coordinates-with src-tauri/src/terminal_transcript/follow.rs — the cursor and delta contract
 * @module components/Terminal/useTerminalTranscript */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { transcriptToken } from "@/services/terminal/transcriptBinding";
import { appendTranscript, EMPTY_TRANSCRIPT, TRANSCRIPT_TEXT_LIMIT, type TranscriptMessage } from "@/utils/terminalTranscript";
import { terminalLog } from "@/utils/debug";
/** Opaque here: echoed back so the backend can resume from it, or decide that it cannot. */
interface Cursor { identity: string; offset: number; size: number; modified: string }
interface Delta { cursor: Cursor; reset: boolean; data: string }
interface View { sessionId: string | null; messages: TranscriptMessage[]; failed: boolean; loaded: boolean }
/** Characters of message text held — the same bound the backend puts on a fresh tail. */
export const TRANSCRIPT_TAIL_LIMIT = TRANSCRIPT_TEXT_LIMIT;
export function useTerminalTranscript(sessionId: string | null, active: boolean) {
  const [view, setView] = useState<View>({ sessionId: null, messages: [], failed: false, loaded: false });
  useEffect(() => {
    if (!active || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: Cursor | null = null;
    let tail = EMPTY_TRANSCRIPT;
    let lastToken: string | undefined;
    let failing = false;
    const startOver = () => { cursor = null; tail = EMPTY_TRANSCRIPT; };
    const poll = async () => {
      try {
        const token = transcriptToken(sessionId);
        if (token !== lastToken) {
          lastToken = token;
          startOver();
          if (!cancelled) setView({ sessionId, messages: [], failed: false, loaded: false });
        }
        if (!token) return;
        const delta = await invoke<Delta | null>("terminal_transcript_read", { token, cursor });
        failing = false;
        if (cancelled || transcriptToken(sessionId) !== token) return;
        if (!delta) {
          startOver();
          setView({ sessionId, messages: [], failed: false, loaded: true });
        } else {
          cursor = delta.cursor;
          // Nothing appended and nothing replaced: what is shown is still right.
          if (delta.reset || delta.data) {
            tail = appendTranscript(delta.reset ? EMPTY_TRANSCRIPT : tail, delta.data);
            setView({ sessionId, messages: tail.messages, failed: false, loaded: true });
          }
        }
      } catch (error) {
        // Polling retries every second; log the transition, not every attempt.
        if (!failing) terminalLog("Transcript read failed:", error);
        failing = true;
        startOver();
        if (!cancelled) setView({ sessionId, messages: [], failed: true, loaded: false });
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sessionId, active]);
  return view.sessionId === sessionId ? view : { sessionId, messages: [], failed: false, loaded: false };
}
