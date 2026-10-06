/**
 * Close one tab even if it is pinned — for the deliberate closes only.
 *
 * Purpose: a pin protects a tab from an accidental close, so the close
 * lifecycle refuses a pinned tab. "Close All" (after its confirmation) and
 * closing a whole workspace are deliberate, and must not be stopped by it.
 * This lifts the pin for this one tab's close attempt and puts it back, in
 * the same place, when the close is refused (a cancelled save prompt).
 *
 * Key decisions:
 *   - The pin is lifted immediately before the close, never for a batch in
 *     advance, so a cancel elsewhere leaves every other pin untouched.
 *   - Restoring re-pins the tab and then moves it back beside the pinned tab
 *     that was on its left (or to the front when there was none): re-pinning
 *     alone appends it to the END of the pinned group, which would reorder
 *     the strip as a side effect of a cancel.
 *   - Pinning DURING the save prompt is the lifecycle's "keep this" signal
 *     and makes it refuse; the restore then finds the tab already pinned and
 *     leaves it as the user set it.
 *
 * @coordinates-with closeAllTabs.ts — Close All
 * @coordinates-with services/workspaces/closeWorkspaceInstance.ts — workspace close
 * @module services/tabs/closeLiftingPin
 */
import { useTabStore, type Tab } from "@/stores/tabStore";

/** Closes one tab; resolves false when the user cancelled. */
export type CloseOneTab = (tabId: string) => Promise<boolean>;

const windowTabs = (windowLabel: string): Tab[] => useTabStore.getState().getTabsByWindow(windowLabel);

/** Re-pin `tabId` and move it back to just after `leftId` (or to the front). */
function restorePin(windowLabel: string, tabId: string, leftId: string | null): void {
  const { togglePin, reorderTabs } = useTabStore.getState();
  togglePin(windowLabel, tabId);

  const tabs = windowTabs(windowLabel);
  const from = tabs.findIndex((tab) => tab.id === tabId);
  const leftIndex = leftId ? tabs.findIndex((tab) => tab.id === leftId && tab.isPinned) : -1;
  const to = leftIndex === -1 ? 0 : leftIndex + (leftIndex < from ? 1 : 0);
  if (from !== -1 && from !== to) reorderTabs(windowLabel, from, to);
}

/**
 * Close `tabId` through `closeOne`, lifting its pin for the attempt.
 *
 * @returns true when the tab is gone (or already was); false when the close
 *   was refused, in which case a lifted pin has been put back where it was.
 */
export async function closeLiftingPin(
  windowLabel: string,
  tabId: string,
  closeOne: CloseOneTab,
): Promise<boolean> {
  const before = windowTabs(windowLabel);
  const index = before.findIndex((tab) => tab.id === tabId);
  if (index === -1) return true;
  const wasPinned = before[index].isPinned;
  const leftId = index > 0 && before[index - 1].isPinned ? before[index - 1].id : null;

  if (wasPinned) useTabStore.getState().togglePin(windowLabel, tabId);
  const closed = await closeOne(tabId);

  const after = windowTabs(windowLabel).find((tab) => tab.id === tabId);
  if (!closed && wasPinned && after && !after.isPinned) restorePin(windowLabel, tabId, leftId);
  return closed;
}
