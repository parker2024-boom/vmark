/**
 * terminalSessionRegistry
 *
 * Purpose: Pure registry/visibility helpers for terminal sessions, extracted
 * from useTerminalSessions so that hook focuses on wiring. These operate on a
 * sessions map and carry no React state.
 *
 * Key decisions:
 *   - switchVisibility starts a session's first shell but does not reset its
 *     terminal: startShell resets for every new PTY (#1471).
 *   - removeSessionEntry releases the session's transcript binding, which
 *     deletes its binding file (transcriptBinding.forgetTranscriptBinding).
 *
 * @coordinates-with useTerminalSessions.ts — sole caller
 * @coordinates-with useTerminalShellLifecycle.ts — startShell, which resets the terminal
 * @module components/Terminal/terminalSessionRegistry
 */
import { forgetTranscriptBinding } from "@/services/terminal/transcriptBinding";
import type { SessionEntry, SessionsRef } from "./terminalSessionTypes";
import { fitAndResizePty } from "./fitAndResizePty";
import { terminalLog } from "@/utils/debug";

/** Remove a session — cancel pending rAF, dispose the instance, then kill the
 *  PTY (dispose-before-kill so a dispose-time IME flush reaches a live PTY). */
export function removeSessionEntry(
  sessionsRef: SessionsRef,
  sessionId: string,
): void {
  const entry = sessionsRef.current.get(sessionId);
  if (!entry) return;
  entry.disposed = true;
  if (entry.pendingRafId !== null) {
    cancelAnimationFrame(entry.pendingRafId);
    entry.pendingRafId = null;
  }
  // Dispose BEFORE kill: instance.dispose() flushes a pending IME
  // commit through the PTY, so the session must still be live. Catch (not just
  // finally) so a throwing dispose never propagates — the PTY is still killed
  // and the entry removed, instead of leaking the PTY and orphaning the entry.
  try {
    entry.instance.dispose();
  } catch (e) {
    terminalLog("session dispose threw:", e);
  }
  if (entry.pty) {
    try {
      entry.pty.kill();
    } catch {
      /* ignore */
    }
  }
  forgetTranscriptBinding(sessionId);
  sessionsRef.current.delete(sessionId);
}

/** Show the active session's container, hide others, and lazily spawn its shell
 *  after the container is visible and fitAddon has measured real dimensions. */
export function switchVisibility(
  sessionsRef: SessionsRef,
  activeId: string | null,
  startShell: (sessionId: string) => void,
): void {
  for (const [id, entry] of sessionsRef.current) {
    if (id === activeId) {
      entry.instance.container.style.display = "block";
    } else {
      entry.instance.container.style.display = "none";
      entry.instance.searchAddon.clearDecorations();
      // Cancel pending RAF to prevent spawning a shell while hidden.
      if (entry.pendingRafId !== null) {
        cancelAnimationFrame(entry.pendingRafId);
        entry.pendingRafId = null;
      }
    }
  }
  if (!activeId) return;
  const entry = sessionsRef.current.get(activeId);
  if (!entry) return;
  if (entry.pendingRafId !== null) {
    cancelAnimationFrame(entry.pendingRafId);
    entry.pendingRafId = null;
  }
  entry.pendingRafId = requestAnimationFrame(() => {
    entry.pendingRafId = null;
    // Fit AND resize: a hidden session that missed geometry changes while it
    // was display:none (a font-size change applies term.options to every
    // session, but fit() no-ops on a zero-size container) would otherwise come
    // back with its PTY still on the pre-change dimensions. For a session whose
    // shell hasn't started yet this is harmless — spawnPty reads term.cols
    // after the fit, and the debounced resize is skipped via the null pty.
    fitAndResizePty(entry, () => sessionsRef.current.get(activeId) !== entry);
    try {
      entry.instance.term.focus();
    } catch {
      /* ignore */
    }

    // Start shell after first fit so PTY gets the real dimensions instead of
    // 80×24 defaults from a hidden container. startShell resets the terminal
    // first (as for every new PTY), which also clears the blank-line artifacts
    // of opening xterm in a hidden (display:none) container.
    if (!entry.shellStarted && !entry.shellExited && !entry.disposed) {
      entry.shellStarted = true;
      startShell(activeId);
    }
  });
}

/** Dispose every session in the map (mount-effect cleanup). */
export function disposeAllSessions(sessions: Map<string, SessionEntry>): void {
  for (const [, entry] of sessions) {
    entry.disposed = true;
    if (entry.pendingRafId !== null) {
      cancelAnimationFrame(entry.pendingRafId);
      entry.pendingRafId = null;
    }
    clearTimeout(entry.ptyResizeTimer);
    entry.ptyResizeTimer = undefined;
    // Dispose BEFORE kill — see removeSessionEntry. Catch per entry so
    // one throwing dispose never blocks cleanup of the remaining sessions.
    try {
      entry.instance.dispose();
    } catch (e) {
      terminalLog("session dispose threw:", e);
    }
    if (entry.pty) {
      try {
        entry.pty.kill();
      } catch {
        /* ignore */
      }
    }
  }
  sessions.clear();
}
