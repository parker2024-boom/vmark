/**
 * Workspace Rail Feature Flag
 *
 * Reads from settingsStore.general.workspaceRailMode (persisted).
 *
 * @module services/featureFlags/workspaceRailFeatureFlag
 */

import { useSettingsStore } from "@/stores/settingsStore";

/** Check if the workspace rail/window model is enabled for imperative code. */
export function isWorkspaceRailEnabled(): boolean {
  return useSettingsStore.getState().general?.workspaceRailMode ?? false;
}
