/**
 * Terminal session store — the window's terminal sessions and their
 * per-workspace-instance scoping.
 *
 * Purpose: owns the session list, the shown session (`activeSessionId`) and
 * the per-scope "last shown" memory, with the base session actions
 * (`./terminalStore/sessionActions.ts`) and the scope-transition kernel the
 * workspace rail and the instance lifecycle call
 * (`./terminalStore/scopeActions.ts`). Visibility selectors live in
 * `./terminalStore/scopeSelectors.ts`.
 *
 * Key decisions:
 *   - Panel chrome (visibility, size, docked position) stays in uiStore: it is
 *     window layout, persisted by hot exit. Session state is not persisted at
 *     all (PTYs die at relaunch), so this store starts empty in every window
 *     and has no migration to carry.
 *   - No action here writes uiStore and no uiStore action writes here, so no
 *     transition needs both stores updated atomically.
 *   - Action names keep their `terminal` prefix: they are unique across the
 *     codebase and greppable, which a bare `createSession` would not be.
 *
 * @coordinates-with stores/uiStore.ts — panel chrome for the same panel
 * @coordinates-with components/Terminal/useTerminalSessionsInit.ts — the
 *   reconcile subscription that turns a removed id into a PTY kill
 * @module stores/terminalStore
 */

import { create } from "zustand";
import type { TerminalStore } from "./terminalStore/types";
import {
  createTerminalActions,
  initialTerminal,
  resetTerminalIdCounter,
} from "./terminalStore/sessionActions";
import { createTerminalScopeActions } from "./terminalStore/scopeActions";

export type { TerminalSession, TerminalStore } from "./terminalStore/types";
export { MAX_TERMINAL_SESSIONS } from "./terminalStore/sessionActions";

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  ...initialTerminal,
  ...createTerminalActions(set, get),
  ...createTerminalScopeActions(set, get),
}));

/** Reset session state + ID counter — for tests only. */
export function resetTerminalSessionStore(): void {
  resetTerminalIdCounter();
  useTerminalStore.setState(initialTerminal);
}
