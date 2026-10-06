/**
 * History Operations
 *
 * Purpose: Async CRUD for document version history — creating snapshots,
 *   loading past versions, deleting individual snapshots, pruning old entries,
 *   and managing the index file.
 *
 * Pipeline: Save triggers → createSnapshot(filePath, content) → file size guard
 *   → wait behind earlier operations on this document's history → merge window
 *   check → write to appDataDir/history/{hash}/ → update index.json → prune if
 *   over limit
 *
 * Key decisions:
 *   - Every exported operation runs on the document's history queue, reads
 *     included. An operation is a read-modify-write of the index; two that
 *     overlapped each started from the same list and the later write discarded
 *     the earlier one's change — see historyQueue.ts
 *   - The exported functions queue; the `*Step` functions below do not. A
 *     composite operation (a snapshot prunes, a revert reads then snapshots) is
 *     ONE queued operation built from steps, because a queued operation that
 *     queued another and awaited it would wait for itself
 *   - A revert reads its target BEFORE taking the safety snapshot. Taking it
 *     prunes, and at the snapshot limit the prune removes the oldest entry —
 *     the version being restored, if that was the one asked for
 *   - Pruning respects HistorySettings (max count, max age)
 *   - Merge window consolidates consecutive auto-saves into one snapshot
 *   - File size guard skips snapshots for oversized files before any I/O
 *
 * @coordinates-with historyQueue.ts — orders operations per document
 * @coordinates-with historyStorage.ts — paths, and the index/snapshot file steps
 * @coordinates-with historyTypes.ts — shared types and constants
 * @coordinates-with historyRecovery.ts — removal of whole histories
 * @module services/history/historyOperations
 */

import { mkdir, exists, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import i18n from "@/i18n";
import { historyLog, historyError } from "@/utils/debug";
import {
  type Snapshot,
  type HistoryIndex,
  type HistorySettings,
  createHistoryIndex,
  generatePreview,
  getByteSize,
  hashPath,
} from "@/utils/historyTypes";
import { serializeHistory } from "./historyQueue";
import {
  getDocHistoryDir,
  getHistoryBaseDir,
  readHistoryIndex,
  readSnapshot,
  saveHistoryIndex,
} from "./historyStorage";

// Re-export types for consumers
export type { Snapshot, HistoryIndex, HistorySettings };

// Export the base dir getter for recovery operations
export { getHistoryBaseDir };

type SnapshotType = Snapshot["type"];

// Steps — single-document work that assumes it already holds its turn in the
// queue. Never exported: the queued operations below are the only way in.

/**
 * Write one snapshot and its index entry, then prune.
 */
async function createSnapshotStep(
  documentPath: string,
  content: string,
  type: SnapshotType,
  settings: HistorySettings
): Promise<void> {
  try {
    // Compute hash and ensure dir in one pass (avoids double hashPath)
    const baseDir = await getHistoryBaseDir();
    const hash = await hashPath(documentPath);
    const historyDir = await join(baseDir, hash);
    if (!(await exists(historyDir))) {
      await mkdir(historyDir, { recursive: true });
    }

    // Get or create index
    const index =
      (await readHistoryIndex(documentPath)) ??
      createHistoryIndex(documentPath, hash, settings, i18n.t("common:untitled"));

    const timestamp = Date.now();

    // Merge window — replace last auto snapshot if within window
    if (
      type === "auto" &&
      settings.mergeWindowSeconds > 0 &&
      index.snapshots.length > 0
    ) {
      // Sort to ensure we check the actual newest snapshot (defensive against corruption)
      index.snapshots.sort((a, b) => a.timestamp - b.timestamp);
      const lastSnapshot = index.snapshots[index.snapshots.length - 1];
      const windowMs = settings.mergeWindowSeconds * 1000;
      if (
        lastSnapshot.type === "auto" &&
        timestamp >= lastSnapshot.timestamp &&
        timestamp - lastSnapshot.timestamp <= windowMs
      ) {
        const oldPath = await join(historyDir, `${lastSnapshot.id}.md`);
        try {
          if (await exists(oldPath)) await remove(oldPath);
          // Only pop if deletion succeeded — avoid orphaning the index reference
          index.snapshots.pop();
          historyLog("Merged with previous auto snapshot:", lastSnapshot.id);
        } catch {
          historyLog("Merge cleanup failed, keeping both snapshots:", lastSnapshot.id);
        }
      }
    }

    // Create snapshot with unique ID (timestamp + random suffix for collision safety)
    const snapshotId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshotPath = await join(historyDir, `${snapshotId}.md`);

    // Write snapshot content
    await writeTextFile(snapshotPath, content);

    // Update index
    const snapshot: Snapshot = {
      id: snapshotId,
      timestamp,
      type,
      size: content.length,
      preview: generatePreview(content),
    };

    index.snapshots.push(snapshot);
    index.status = "active";
    index.deletedAt = null;
    index.settings = settings;

    // Save index
    await saveHistoryIndex(documentPath, index);

    // Prune old snapshots
    await pruneSnapshotsStep(documentPath);

    historyLog(`Created ${type} snapshot:`, snapshotId);
  } catch (error) {
    historyError("Failed to create snapshot:", error);
    throw error;
  }
}

/**
 * Remove snapshots past the age limit, then all but the newest `maxSnapshots`.
 */
async function pruneSnapshotsStep(documentPath: string): Promise<void> {
  try {
    const index = await readHistoryIndex(documentPath);
    if (!index || index.snapshots.length === 0) return;

    const { maxSnapshots, maxAgeDays } = index.settings;
    const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const historyDir = await getDocHistoryDir(documentPath);

    // Step 1: Filter out snapshots older than cutoff
    const withinAge = index.snapshots.filter((s) => s.timestamp >= cutoffTime);

    // Step 2: Sort by timestamp descending and keep only newest maxSnapshots
    const sorted = [...withinAge].sort((a, b) => b.timestamp - a.timestamp);
    const toKeep = sorted.slice(0, maxSnapshots);
    const toKeepIds = new Set(toKeep.map((s) => s.id));

    // Step 3: Identify snapshots to remove
    const toRemove = index.snapshots.filter((s) => !toKeepIds.has(s.id));

    // Delete snapshot files
    for (const snapshot of toRemove) {
      try {
        const snapshotPath = await join(historyDir, `${snapshot.id}.md`);
        if (await exists(snapshotPath)) {
          await remove(snapshotPath);
        }
      } catch {
        // Ignore deletion errors for individual snapshots
      }
    }

    // Update index with kept snapshots (maintain original order)
    index.snapshots = index.snapshots.filter((s) => toKeepIds.has(s.id));
    await saveHistoryIndex(documentPath, index);

    if (toRemove.length > 0) {
      historyLog(`Pruned ${toRemove.length} old snapshots`);
    }
  } catch (error) {
    /* v8 ignore next -- @preserve reason: catch only fires on Tauri filesystem errors; not reproducible in mocked tests */
    historyError("Failed to prune snapshots:", error);
  }
}

/**
 * Remove one snapshot's file and its index entry.
 */
async function deleteSnapshotStep(documentPath: string, snapshotId: string): Promise<void> {
  try {
    const index = await readHistoryIndex(documentPath);
    if (!index) return;

    const snapshotIndex = index.snapshots.findIndex((s) => s.id === snapshotId);
    if (snapshotIndex === -1) return;

    // Delete snapshot file (tolerate missing)
    try {
      const historyDir = await getDocHistoryDir(documentPath);
      const snapshotPath = await join(historyDir, `${snapshotId}.md`);
      await remove(snapshotPath);
    } catch {
      // File may already be missing — continue to update index
    }

    // Remove from index and save
    index.snapshots.splice(snapshotIndex, 1);
    await saveHistoryIndex(documentPath, index);

    historyLog("Deleted snapshot:", snapshotId);
  } catch (error) {
    /* v8 ignore next -- @preserve reason: catch only fires on Tauri filesystem errors; not reproducible in mocked tests */
    historyError("Failed to delete snapshot:", error);
  }
}

// Queued operations — the public surface.

/**
 * Get the index for a document, or null if it has no readable history
 */
export function getHistoryIndex(documentPath: string): Promise<HistoryIndex | null> {
  return serializeHistory(documentPath, () => readHistoryIndex(documentPath));
}

/**
 * Create a new snapshot of the document
 */
export async function createSnapshot(
  documentPath: string,
  content: string,
  type: SnapshotType,
  settings: HistorySettings
): Promise<void> {
  // File size guard — only for auto-saves; manual/revert always create a safety snapshot
  if (type === "auto" && settings.maxFileSizeKB > 0) {
    const sizeKB = getByteSize(content) / 1024;
    if (sizeKB > settings.maxFileSizeKB) {
      historyLog(
        "Skipping snapshot — file size",
        Math.round(sizeKB),
        "KB exceeds limit",
        settings.maxFileSizeKB,
        "KB"
      );
      return;
    }
  }

  await serializeHistory(documentPath, () =>
    createSnapshotStep(documentPath, content, type, settings)
  );
}

/**
 * Get list of snapshots for a document
 */
export function getSnapshots(documentPath: string): Promise<Snapshot[]> {
  return serializeHistory(documentPath, async () => {
    const index = await readHistoryIndex(documentPath);
    if (!index) return [];
    // Return sorted by timestamp descending (newest first)
    return [...index.snapshots].sort((a, b) => b.timestamp - a.timestamp);
  });
}

/**
 * Load a specific snapshot's content
 */
export function loadSnapshot(documentPath: string, snapshotId: string): Promise<string | null> {
  return serializeHistory(documentPath, () => readSnapshot(documentPath, snapshotId));
}

/**
 * Revert to a snapshot: read it, snapshot the current state as a safety copy,
 * and return the content to restore — or null when the target does not exist.
 */
export function revertToSnapshot(
  documentPath: string,
  snapshotId: string,
  currentContent: string,
  settings: HistorySettings
): Promise<string | null> {
  return serializeHistory(documentPath, async () => {
    // Read first — see the header for why the order matters.
    const restored = await readSnapshot(documentPath, snapshotId);
    await createSnapshotStep(documentPath, currentContent, "revert", settings);
    return restored;
  });
}

/**
 * Clean up old snapshots based on settings
 *
 * Pruning strategy:
 * 1. Remove snapshots older than maxAgeDays
 * 2. Keep only the newest maxSnapshots from what remains
 */
export function pruneSnapshots(documentPath: string): Promise<void> {
  return serializeHistory(documentPath, () => pruneSnapshotsStep(documentPath));
}

/**
 * Delete a single snapshot from a document's history
 */
export function deleteSnapshot(documentPath: string, snapshotId: string): Promise<void> {
  return serializeHistory(documentPath, () => deleteSnapshotStep(documentPath, snapshotId));
}
