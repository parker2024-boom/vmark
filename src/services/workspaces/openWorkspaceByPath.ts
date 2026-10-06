/**
 * openWorkspaceByPath — the single "open a folder as the workspace" operation.
 *
 * Both the "Open Folder" menu command (after its dialog) and the open_workspace
 * MCP handler call this, so opening a folder is ONE code path and can't
 * half-open (store set but tabs/rail/split not restored — plan ADR-1).
 *
 * REQUIRES the caller to hold the per-window transition guard
 * (WORKSPACE_TRANSITION_GUARD) around this call (Codex F-08): the menu command
 * guards the dialog + this call together; the MCP handler guards this call.
 *
 * REQUIRES the caller to have settled ACCESS to `path` first (WI-LX1.1): every
 * caller does — the picker grants what it returns, and Open Recent and the
 * open_workspace MCP tool ask Rust (`resolveWorkspaceAccess`) and act on the
 * answer. This used to re-grant as well, asking Rust twice per open;
 * a new caller that opens a folder it did not pick must ask first.
 * Running two transitions unguarded interleaves restore tabs/split into
 * whichever workspace lands last. Opening a workspace is safe with unsaved
 * changes — it does not close existing tabs, so dirty docs survive (#1005);
 * restoreWorkspaceTabs skips files already open in the window.
 *
 * @coordinates-with services/commands/workspaceCommands.ts — menu "Open Folder"
 * @coordinates-with services/commands/recentWorkspacesCommands.ts — "Open Recent"
 * @coordinates-with services/mcpBridge/v2/workspaceOpenFolder.ts — open_workspace handler
 * @coordinates-with services/workspaces/workspaceAccess.ts — how callers settle access
 * @module services/workspaces/openWorkspaceByPath
 */
import { useUIStore } from "@/stores/uiStore";
import { useRecentWorkspacesStore } from "@/stores/workspaceStore";
import { openWorkspaceWithConfig } from "@/services/workspaces/openWorkspaceWithConfig";
import { restoreWorkspaceTabs, restoreSplitLayout } from "@/services/navigation/restoreWorkspaceTabs";
import { documentPathsForRestore } from "@/services/persistence/sessionTabs";
import { workspaceError } from "@/utils/debug";

/**
 * The re-entry guard key shared by EVERY command that transitions the window's
 * workspace (open folder, open recent, close). One key per window: two
 * transitions that interleave restore tabs/split into whichever workspace lands
 * last, and a close racing an open persists a half-torn-down workspace.
 */
export const WORKSPACE_TRANSITION_GUARD = "workspace-transition";

/**
 * Run the full open-workspace sequence (config → sidebar → recents → tab
 * restore → split restore) for `path` in the given window (default "main").
 * Never throws — failures are logged, so a caller is not broken by a bad path.
 * Returns whether the sequence completed: menu callers ignore it (best-effort),
 * but the MCP handler MUST fail closed on `false` rather than report a success
 * that did not happen. The caller MUST hold WORKSPACE_TRANSITION_GUARD (see
 * module header).
 */
export async function openWorkspaceByPath(
  path: string,
  options: { windowLabel?: string } = {},
): Promise<boolean> {
  const windowLabel = options.windowLabel ?? "main";
  try {
    const existing = await openWorkspaceWithConfig(path, { windowLabel });
    useUIStore.getState().showSidebarWithView("files");
    useRecentWorkspacesStore.getState().addWorkspace(path);
    await restoreWorkspaceTabs(
      windowLabel,
      existing ? documentPathsForRestore(existing) : undefined,
    );
    restoreSplitLayout(windowLabel, path);
    return true;
  } catch (error) {
    workspaceError("Failed to open workspace:", error);
    return false;
  }
}
