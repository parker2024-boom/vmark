/**
 * Real-xterm probes for terminal-STATE tests.
 *
 * `src/test/setup.ts` mocks `@xterm/xterm` for the whole app tier, so a test
 * that needs to know what the terminal will actually DO — which bytes a mouse
 * move or a paste produces — imports the real module here. An unopened
 * Terminal still runs the full VT parser, which is where every mode lives.
 *
 * State is read back through the terminal's own report sequences (DECRQM for
 * modes, DECRQSS for SGR and scroll margins), i.e. the public protocol any
 * program could use — never through xterm internals.
 *
 * @module components/Terminal/realXterm.testUtils
 */

import { vi } from "vitest";
import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from "@xterm/xterm";

const { Terminal: RealTerminal } =
  await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");

/** A real, unopened xterm with production-like options. */
export function createRealTerminal(
  options: ITerminalOptions & ITerminalInitOnlyOptions = {},
): Terminal {
  return new RealTerminal({ cols: 80, rows: 24, allowProposedApi: true, ...options });
}

/** Resolve once xterm has parsed everything written to it so far. */
export function flushWrites(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write("", resolve));
}

/** Write `data` and resolve once it has been parsed. */
export function writeParsed(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/**
 * Everything a full-screen TUI (Codex, Claude Code, vim, htop…) turns on and
 * only turns off again if it exits cleanly. Killed mid-run, it leaves all of it.
 */
export const TUI_LEFTOVER_CASES: ReadonlyArray<readonly [label: string, sequence: string]> = [
  ["alternate screen", "\x1b[?1049h"],
  ["hidden cursor", "\x1b[?25l"],
  ["X10 mouse", "\x1b[?9h"],
  ["click mouse, SGR", "\x1b[?1000h\x1b[?1006h"],
  ["drag mouse, SGR-pixels", "\x1b[?1002h\x1b[?1016h"],
  ["any-event mouse, SGR", "\x1b[?1003h\x1b[?1006h"],
  ["focus reporting", "\x1b[?1004h"],
  ["bracketed paste", "\x1b[?2004h"],
  ["application cursor keys", "\x1b[?1h"],
  ["application keypad", "\x1b="],
  ["synchronized output", "\x1b[?2026h"],
  ["insert mode", "\x1b[4h"],
  ["linefeed/newline mode", "\x1b[20h"],
  ["origin mode", "\x1b[?6h"],
  ["autowrap off", "\x1b[?7l"],
  ["reverse wraparound", "\x1b[?45h"],
  ["cursor blink off", "\x1b[?12l"],
  ["scroll region", "\x1b[3;10r"],
];

/**
 * All of TUI_LEFTOVER_CASES at once, plus two leftovers no report can query
 * (xterm answers DECRQSS `m` with a constant `0m`): SGR attributes and the DEC
 * line-drawing charset. Those show in the cells of text written afterwards —
 * bold/red, and "shell" drawn as box corners.
 */
export const TUI_LEFTOVERS =
  TUI_LEFTOVER_CASES.map(([, sequence]) => sequence).join("") +
  "\x1b[1;4;31;44m" +
  "\x1b(0";

/** DECRQM / DECRQSS queries covering every queryable mode TUI_LEFTOVER_CASES
 *  touches, including cursor blink (?12), which xterm stores in an option. */
const SESSION_STATE_QUERIES = [
  ...[1, 6, 7, 9, 12, 25, 45, 47, 66, 1000, 1002, 1003, 1004, 1006, 1016, 1047, 1049, 2004, 2026]
    .map((mode) => `\x1b[?${mode}$p`),
  "\x1b[4$p",
  "\x1b[20$p",
  "\x1bP$qr\x1b\\", // DECSTBM (scroll region)
];

/**
 * Ask the terminal for its state, one reply per query, in order. Replies go
 * out through onData — the same channel as mouse/focus reports and keystrokes.
 */
export async function queryState(
  term: Terminal,
  queries: readonly string[] = SESSION_STATE_QUERIES,
): Promise<string[]> {
  const replies: string[] = [];
  let current = "";
  const sub = term.onData((data) => {
    current += data;
  });
  try {
    for (const query of queries) {
      current = "";
      await writeParsed(term, query);
      replies.push(current);
    }
  } finally {
    sub.dispose();
  }
  return replies;
}

/** The replies a never-used terminal with `options` gives — the pristine state. */
export async function pristineState(options: ITerminalOptions = {}): Promise<string[]> {
  const fresh = createRealTerminal(options);
  try {
    return await queryState(fresh);
  } finally {
    fresh.dispose();
  }
}

/** Text of every buffer row (active buffer), right-trimmed. */
export function bufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return rows.join("\n");
}
