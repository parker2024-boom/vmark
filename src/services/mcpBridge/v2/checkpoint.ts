/**
 * Purpose: record the checkpoint a bridge write leaves behind — the document
 * as it was before an MCP tool changed it, so the user can go back.
 *
 * Shared by `document.write`, `document.transform` and `selection.set`, which
 * each carried their own copy of the same two steps.
 *
 * Key decisions:
 *   - Pushed to the store synchronously, so a caller can read the checkpoint
 *     back as soon as the handler has replied.
 *   - Appended to disk asynchronously and never awaited: a failed history
 *     write is logged by the persistence layer and must not fail the MCP
 *     request it describes.
 *
 * @coordinates-with stores/mcpStore.ts — the in-memory checkpoint list
 * @coordinates-with stores/mcpCheckpointPersistence.ts — the append-only file
 * @module services/mcpBridge/v2/checkpoint
 */
import { useMcpStore, type CheckpointTool } from "@/stores/mcpStore";
import { appendCheckpoint } from "@/stores/mcpCheckpointPersistence";

export interface BridgeCheckpoint {
  tabId: string;
  filePath: string | null;
  tool: CheckpointTool;
  /** One line for the checkpoint panel. */
  description: string;
  contentBefore: string;
  revisionBefore: string;
  revisionAfter: string;
}

/** Record the checkpoint for a write that has just changed a document. */
export function recordBridgeCheckpoint(checkpoint: BridgeCheckpoint): void {
  const id = useMcpStore.getState().checkpointPush(checkpoint);
  const stored = useMcpStore.getState().checkpointGet(id);
  if (stored) void appendCheckpoint(stored);
}

/**
 * "Wrote document (+12 chars, was 30, now 42)" — the size change a write made,
 * for the checkpoint panel. `verb` names what was written.
 */
export function describeSizeChange(verb: string, before: string, after: string): string {
  const delta = after.length - before.length;
  const sign = delta >= 0 ? "+" : "−";
  return `${verb} (${sign}${Math.abs(delta)} chars, was ${before.length}, now ${after.length})`;
}
