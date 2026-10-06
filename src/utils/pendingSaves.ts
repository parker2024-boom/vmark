/**
 * Pending Saves Tracker (Content-Based)
 *
 * Purpose: Tracks the exact content being written to files to reliably
 * distinguish our own saves from external modifications in file watcher events.
 *
 * This is a content-based approach that eliminates timing race conditions:
 * - Stores the exact content we're about to write
 * - On file watcher event, compare disk content to pending content
 * - If they match, it's our save (regardless of timing)
 *
 * Usage:
 * 1. Call registerPendingSave(path, content) BEFORE the write
 *    — returns a token for safe clearing
 * 2. After a SUCCESSFUL write, call clearPendingSaveAfterGrace(path, token):
 *    the registration outlives the write by PENDING_SAVE_GRACE_MS so a late
 *    watcher event still matches. After a FAILED write, call
 *    clearPendingSave(path, token) at once — nothing reached the disk, so
 *    there is no echo to wait for. Either way the clear only happens if the
 *    token matches (overlapping saves cannot clear each other's registrations)
 * 3. Use matchesPendingSave(path, diskContent) to check if disk matches what we wrote
 *
 * Key decisions:
 *   - Content comparison (not timestamp-based) because filesystem timestamps
 *     have platform-dependent resolution and can race with watcher events
 *   - Map keyed by normalized path for cross-platform consistency
 *   - Token-based clearing prevents overlapping saves to the same path
 *     from prematurely clearing a newer registration
 *   - The grace window is ONE constant and ONE helper. It is a contract with
 *     the watcher pipeline, not a per-caller choice: a caller that clears
 *     early turns its own write into a "file changed on disk" prompt
 *
 * @coordinates-with saveToPath.ts — registers pending save before write
 * @coordinates-with reloadFromDisk.ts — checks matchesPendingSave to skip self-triggered reloads
 * @coordinates-with services/workspaceEvents/normalizeFsEvents — hasPendingSave flags self-write echoes
 * @module utils/pendingSaves
 */

import { normalizePath } from "@/utils/paths";

interface PendingEntry {
  content: string;
  token: number;
}

/** Map of normalized path -> pending save entry */
const pendingSaves = new Map<string, PendingEntry>();

/** Monotonically increasing token counter */
let nextToken = 1;

/**
 * Register that we're about to save specific content to a file.
 * Call this BEFORE the write.
 *
 * @param path - File path being saved to
 * @param content - The exact content being written
 * @returns A token to pass to clearPendingSave for safe clearing
 */
export function registerPendingSave(path: string, content: string): number {
  const normalized = normalizePath(path);
  const token = nextToken++;
  pendingSaves.set(normalized, { content, token });
  return token;
}

/**
 * Clear a pending save NOW, but only if the token matches the current
 * registration. This prevents overlapping saves from clearing each other's
 * entries. For a write that succeeded, use `clearPendingSaveAfterGrace`.
 *
 * @param path - File path to clear
 * @param token - Token returned by registerPendingSave. If omitted, clears unconditionally.
 */
export function clearPendingSave(path: string, token?: number): void {
  const normalized = normalizePath(path);
  if (token !== undefined) {
    const entry = pendingSaves.get(normalized);
    if (entry && entry.token !== token) return; // Newer save registered — don't clear
  }
  pendingSaves.delete(normalized);
}

/**
 * How long a finished write stays registered, in milliseconds.
 *
 * The watcher reports our own write asynchronously: Rust debounce (200 ms) →
 * emit → JS event loop → async `readDocumentText` → comparison. Under heavy I/O
 * that pipeline has exceeded 500 ms, and macOS FSEvents can deliver late on
 * top of it. The registration has to still be there when the event arrives,
 * or the app asks the user about a change it made itself.
 */
export const PENDING_SAVE_GRACE_MS = 1000;

/**
 * Clear a pending save once the grace window has passed.
 *
 * Token-guarded like `clearPendingSave`: if a newer save registered the same
 * path meanwhile, that registration survives and gets its own full window.
 *
 * @param path - File path to clear
 * @param token - Token returned by registerPendingSave
 */
export function clearPendingSaveAfterGrace(path: string, token: number): void {
  setTimeout(() => clearPendingSave(path, token), PENDING_SAVE_GRACE_MS);
}

/**
 * Check if the given disk content matches what we're currently writing.
 * This is the core of content-based verification - if the disk content
 * matches our pending save, it's our own save, not an external change.
 *
 * @param path - File path to check
 * @param diskContent - Content read from disk
 * @returns true if disk content matches our pending save
 */
export function matchesPendingSave(path: string, diskContent: string): boolean {
  const normalized = normalizePath(path);
  const entry = pendingSaves.get(normalized);

  if (!entry) {
    return false;
  }

  return diskContent === entry.content;
}

/**
 * Check if a path has a pending save registered.
 * Useful for quick checks before reading the file.
 */
export function hasPendingSave(path: string): boolean {
  const normalized = normalizePath(path);
  return pendingSaves.has(normalized);
}

/** Test helper: clear all pending saves. */
export function _clearAllPendingSaves(): void {
  pendingSaves.clear();
}

