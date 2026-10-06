/**
 * Who asked for a save, and how it ended.
 *
 * Purpose: the vocabulary `saveToPath` and its callers share. Its own module
 * so the MCP bridge, which renders an outcome for an AI client, depends on the
 * types without depending on the pipeline's implementation file for them.
 *
 * Key decisions:
 *   - The failure carries FACTS, not prose. The human pipeline answers a
 *     failure with a localized toast; the MCP bridge answers it with an
 *     English diagnostic for an AI client. One message baked in here would be
 *     wrong for one of them, so each audience renders the reason itself.
 *   - An MCP save always names its tool. The provenance capture needs it, and
 *     a save origin of "mcp" with no tool would have nothing to record.
 *
 * @coordinates-with saveToPath.ts — produces the outcome
 * @coordinates-with services/mcpBridge/v2/bridgeSave.ts — renders it for MCP clients
 * @module services/persistence/saveOutcome
 */
import type { FileOwnershipClaim } from "@/services/workspaces/fileOwnership";

/**
 * Who asked for the save. It decides the feedback (only a manual save may
 * toast), the history snapshot kind, and whose provenance is recorded.
 */
export type SaveOrigin =
  | { saveType: "manual" | "auto" }
  | { saveType: "mcp"; toolName: string };

/** Why a save wrote nothing. */
export type SaveFailure =
  /** Another open tab holds unsaved changes to the same file. */
  | { reason: "ownership-conflict"; conflicts: FileOwnershipClaim[] }
  /** The file's folder no longer exists; the document is now marked missing. */
  | { reason: "parent-missing"; dir: string }
  /** The write itself was rejected; `error` is the raw rejection. */
  | { reason: "write-failed"; error: unknown };

/** How a save ended. `written` is the exact text that reached the disk. */
export type SaveOutcome = { ok: true; written: string } | ({ ok: false } & SaveFailure);
