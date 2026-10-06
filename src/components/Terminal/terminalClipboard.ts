/**
 * terminalClipboard — copy and paste actions shared by the terminal's
 * clipboard chords (Cmd/Ctrl+C/V, Ctrl+Shift+C/V, Ctrl+Insert, Shift+Insert).
 *
 * Key decisions:
 *   - Paste goes through term.paste so xterm applies bracketed-paste wrapping
 *     when the app enabled it — multiline paste won't auto-execute (G2).
 *   - Copy trims trailing whitespace and clears the selection afterwards.
 *
 * @coordinates-with terminalKeyHandler.ts — sole consumer
 * @module components/Terminal/terminalClipboard
 */
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Terminal } from "@xterm/xterm";
import { clipboardWarn } from "@/utils/debug";
import { errorMessage } from "@/utils/errorMessage";

/** Clipboard actions bound to one terminal. */
export interface TerminalClipboard {
  /** Copy the selection to the clipboard. Returns false when nothing is selected. */
  copySelection: () => boolean;
  /** Paste the clipboard text into the terminal. */
  pasteClipboard: () => void;
}

/** Create the clipboard actions for `term`. */
export function createTerminalClipboard(term: Terminal): TerminalClipboard {
  return {
    copySelection() {
      if (!term.hasSelection()) return false;
      writeText(term.getSelection().trimEnd()).catch((error: unknown) => {
        clipboardWarn("Clipboard write failed:", errorMessage(error));
      });
      term.clearSelection();
      return true;
    },
    pasteClipboard() {
      readText().then((text) => {
        if (text) {
          term.paste(text);
        }
      }).catch((error: unknown) => {
        clipboardWarn("Clipboard read failed:", errorMessage(error));
      });
    },
  };
}
