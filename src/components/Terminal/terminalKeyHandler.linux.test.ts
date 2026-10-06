/**
 * The terminal key handler's Linux split, and its Windows contrast.
 *
 * Linux terminals leave plain Ctrl+letter to the shell — readline and
 * full-screen programs bind nearly all of them — and put the terminal's own
 * actions on Ctrl+Shift+letter plus Ctrl+Insert / Shift+Insert. The handler
 * follows that, with two exceptions it keeps on plain Ctrl: Ctrl+C (copy with a
 * selection, SIGINT without) and Ctrl+V (paste), the chords that desktops which
 * remap Super+C / Super+V (Omarchy is one) deliver. Ctrl+1-5 session switching
 * is kept too: shells don't bind Ctrl+digit. Windows has no competing readline
 * convention, so plain Ctrl+A/K/F keep their terminal meanings there.
 *
 * Split from `terminalKeyHandler.test.ts`, which is at its frozen size
 * baseline and may only shrink.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createTerminalKeyHandler } from "./terminalKeyHandler";
import { resetTerminalSessionStore, useTerminalStore } from "@/stores/terminalStore";

vi.mock("@/services/terminal/terminalGate", () => ({
  requestToggleTerminal: vi.fn(), toggleTerminalFocus: vi.fn(),
}));

function event(key: string, shiftKey = false, ctrlKey = true) {
  return new KeyboardEvent("keydown", { key, ctrlKey, shiftKey, cancelable: true });
}
function harness(selection = false) {
  const term = {
    hasSelection: () => selection, getSelection: () => "selected",
    clearSelection: vi.fn(), clear: vi.fn(), selectAll: vi.fn(), paste: vi.fn(),
  };
  const onSearch = vi.fn();
  const handler = createTerminalKeyHandler(term as unknown as Terminal, { current: null }, {
    onSearch, isComposing: () => false,
  });
  return { term, onSearch, handler };
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("navigator", { platform: "Linux aarch64" }); });
afterEach(() => vi.unstubAllGlobals());

describe("Linux terminal control keys", () => {
  it.each(["a", "b", "d", "e", "f", "k", "l", "r", "u", "w", "z"])(
    "passes Ctrl+%s through to readline/foreground programs even with a selection",
    (key) => {
      const { handler, term, onSearch } = harness(true);
      const e = event(key);
      expect(handler(e)).toBe(true);
      expect(e.defaultPrevented).toBe(false);
      expect(term.selectAll).not.toHaveBeenCalled();
      expect(term.clear).not.toHaveBeenCalled();
      expect(onSearch).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
    },
  );
  it("passes Ctrl+C through as SIGINT when nothing is selected", () => {
    const { handler } = harness();
    const e = event("c");
    expect(handler(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("Linux terminal clipboard and action chords (Ctrl+Shift, Ctrl/Shift+Insert)", () => {
  // Desktops that remap Super+C / Super+V (Omarchy, for one) deliver them to a
  // non-terminal window as Ctrl+C / Ctrl+V, so those two stay on plain Ctrl.
  it("copies a selection with Ctrl+C", () => {
    const { handler, term } = harness(true);
    const e = event("c");
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected");
    expect(term.clearSelection).toHaveBeenCalledOnce();
  });
  it("pastes with Ctrl+V through xterm's bracketed-paste path", async () => {
    vi.mocked(readText).mockResolvedValue("你好\nworld");
    const { handler, term } = harness();
    const e = event("v");
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith("你好\nworld"));
  });
  it("copies a selection with Ctrl+Insert", () => {
    const { handler } = harness(true);
    const e = event("Insert");
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected");
  });
  it("consumes Ctrl+Insert without a selection instead of sending an escape sequence", () => {
    const { handler } = harness();
    const e = event("Insert");
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
  it("pastes with Shift+Insert", async () => {
    vi.mocked(readText).mockResolvedValue("pasted");
    const { handler, term } = harness();
    const e = event("Insert", true, false);
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith("pasted"));
  });
  it("uses Ctrl+Shift+C to copy and fully consumes the shortcut", () => {
    const { handler } = harness(true);
    const e = event("C", true);
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected");
  });
  it("uses Ctrl+Shift+V to paste through xterm's bracketed-paste path", async () => {
    vi.mocked(readText).mockResolvedValue("你好\nworld");
    const { handler, term } = harness();
    const e = event("V", true);
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith("你好\nworld"));
  });
  it("uses Ctrl+Shift+K to clear the terminal", () => {
    const { handler, term } = harness();
    const e = event("K", true);
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(term.clear).toHaveBeenCalledOnce();
  });
  it("uses Ctrl+Shift+A to select the terminal buffer", () => {
    const { handler, term } = harness();
    const e = event("A", true);
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(term.selectAll).toHaveBeenCalledOnce();
  });
  it("uses Ctrl+Shift+F to search the terminal", () => {
    const { handler, onSearch } = harness();
    const e = event("F", true);
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(onSearch).toHaveBeenCalledOnce();
  });
});

describe("Linux keeps Ctrl+1-5 for terminal session switching", () => {
  beforeEach(() => resetTerminalSessionStore());

  it.each([1, 2, 3, 4, 5])("Ctrl+%i activates that session instead of reaching the shell", (n) => {
    const store = useTerminalStore.getState();
    const ids = [1, 2, 3, 4, 5].map(() => store.terminalCreateSession()!.id);
    useTerminalStore.getState().terminalSetActiveSession(n === 1 ? ids[1] : ids[0]);
    const { handler } = harness();
    const e = event(String(n));
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(useTerminalStore.getState().activeSessionId).toBe(ids[n - 1]);
  });
});

describe("Windows keeps plain Ctrl+A/K/F as terminal actions", () => {
  beforeEach(() => vi.stubGlobal("navigator", { platform: "Win32" }));

  it("Ctrl+A selects the terminal buffer", () => {
    const { handler, term } = harness();
    const e = event("a");
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(term.selectAll).toHaveBeenCalledOnce();
  });
  it("Ctrl+K clears the terminal", () => {
    const { handler, term } = harness();
    const e = event("k");
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(term.clear).toHaveBeenCalledOnce();
  });
  it("Ctrl+F opens terminal search", () => {
    const { handler, onSearch } = harness();
    const e = event("f");
    expect(handler(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(onSearch).toHaveBeenCalledOnce();
  });
  it("Ctrl+Shift+F passes through without searching", () => {
    const { handler, onSearch } = harness();
    const e = event("F", true);
    expect(handler(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    expect(onSearch).not.toHaveBeenCalled();
  });
});
