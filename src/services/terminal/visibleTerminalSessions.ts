/**
 * visibleTerminalSessions — imperative face of the ONE visibility rule
 * (WI-TS3.1, plan invariant 7).
 *
 * Purpose: non-React callers (key handler, panel-close logic, pickers,
 * auto-create) resolve the window's visible terminal population here; React
 * components use useVisibleTerminalSessions. Both delegate to the pure
 * selector so the rule cannot fork.
 *
 * @coordinates-with stores/terminalStore/scopeSelectors.ts — the pure rule
 * @coordinates-with components/Terminal/useVisibleTerminalSessions.ts — React face
 * @module services/terminal/visibleTerminalSessions
 */
import { isWorkspaceRailEnabled } from "@/services/featureFlags/workspaceRailFeatureFlag";
import { useWorkspaceInstancesStore } from "@/stores/workspaceInstancesStore";
import { selectVisibleTerminalSessions } from "@/stores/terminalStore/scopeSelectors";
import { useTerminalStore, type TerminalSession } from "@/stores/terminalStore";

/** The window's currently-visible terminal sessions (live store read). */
export function getVisibleTerminalSessions(windowLabel: string): TerminalSession[] {
  const activeInstanceId =
    useWorkspaceInstancesStore.getState().windows[windowLabel]
      ?.activeWorkspaceInstanceId ?? null;
  return selectVisibleTerminalSessions(
    useTerminalStore.getState(),
    activeInstanceId,
    isWorkspaceRailEnabled(),
  );
}

/**
 * Realign the active session to the window's CURRENT visible population.
 * A rail-MODE toggle changes what is visible with no
 * scope switch, so no scope action fires — without this, a session hidden by
 * the toggle could stay "active" over an empty tab bar, and the emptiness
 * check in auto-create would see a population it cannot activate. Idempotent:
 * a visible active session is left alone.
 */
export function realignTerminalActiveToVisible(windowLabel: string): void {
  useTerminalStore
    .getState()
    .terminalRealignActive(getVisibleTerminalSessions(windowLabel).map((s) => s.id));
}
