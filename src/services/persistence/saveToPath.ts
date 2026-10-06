/**
 * Save Document to Path
 *
 * Purpose: Central save logic — normalizes content (line endings, hard breaks),
 * re-emits the document's BOM (decision D1), writes to disk, updates stores
 * with the dual save snapshots, records history snapshots, and
 * manages pending save tracking for file watcher coordination.
 *
 * Key decisions:
 *   - Pending save is registered BEFORE write and cleared AFTER with 1000ms delay
 *     to handle late-arriving macOS FSEvents watcher events (full pipeline can
 *     exceed 500ms under heavy I/O: Rust debounce + emit + JS event loop + readFile)
 *   - Line ending and hard break normalization applied on save (not in-memory)
 *     to preserve the original editing experience while writing clean files
 *   - SERIALIZED PER PATH. Saves to one file run in submission order; saves to
 *     different files stay concurrent. Without this an older write could land
 *     second and be recorded as the saved snapshot — see serializeByPath.ts
 *   - History snapshots live in saveHistorySnapshot.ts. Failures don't block
 *     save success, but the call is AWAITED: `saveToPath` does not resolve
 *     until it settles, which close flows need. A hung history backend
 *     therefore holds the save promise open after the file and stores are
 *     already updated; a bounded timeout is the fix if that ever bites
 *   - Auto-save skips recent files list AND skips error toasts to avoid spam on
 *     a flaky disk; the user didn't initiate the action and the next manual save
 *     will surface the error
 *   - ONE pipeline for every writer of a document. An AI client's write over
 *     the MCP bridge enters through `saveToPathForMcp` and gets the same
 *     normalization, ordering, atomic write, history snapshot and saved
 *     snapshots as a human save. What differs is decided here, per origin, and
 *     nowhere else: it never toasts (its caller reports the reason to the
 *     client — a toast on top would report one failure twice), it does not
 *     join the recent files, it never switches the visible workspace, and its
 *     provenance is captured as an MCP write naming the tool
 *   - A failed save says WHY (`SaveOutcome`). `saveToPath` keeps its boolean
 *     for the human callers, which act on document state rather than a reason
 *
 * @coordinates-with pendingSaves.ts — content-based save tracking for watcher coordination
 * @coordinates-with linebreaks.ts — line ending and hard break normalization
 * @coordinates-with documentStore.ts — markSaved/markAutoSaved state updates
 * @coordinates-with serializeByPath.ts — the per-path save queue
 * @coordinates-with saveTargetClaim.ts — per-DOCUMENT identity ordering, which
 *     the per-path queue cannot provide
 * @coordinates-with saveHistorySnapshot.ts — version history snapshots
 * @coordinates-with saveOutcome.ts — who asked for a save and how it ended
 * @coordinates-with saveCapture.ts — fire-and-forget provenance capture, one per
 *     write, human or MCP. `general.coherenceCaptureOnSave` (default OFF) is
 *     enforced by the capture funnel and the kernel for EVERY write path, not here
 * @coordinates-with services/mcpBridge/v2/bridgeSave.ts — the MCP entry's only caller
 * @module services/persistence/saveToPath
 */
import { invoke } from "@tauri-apps/api/core";
import { imeToast as toast } from "@/services/ime/imeToast";
import i18n from "@/i18n";
import { useDocumentStore } from "@/stores/documentStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  resolveWritableFileOwnership,
  showFileOwnershipConflictToast,
} from "@/services/workspaces/fileOwnership";
import {
  resolveHardBreakStyle,
  resolveLineEndingOnSave,
  normalizeHardBreaks,
  normalizeLineEndings,
} from "@/utils/linebreaks";
import { registerPendingSave, clearPendingSave } from "@/utils/pendingSaves";
import { normalizePath } from "@/utils/paths";
import { serializeByPath } from "./serializeByPath";
import { claimSaveTarget, type SaveTargetClaim } from "./saveTargetClaim";
import { applyPostSaveState } from "./applyPostSaveState";
import type { NormalizedSaveContent } from "./normalizedSaveContent";
import { recordHistorySnapshot, type SaveType } from "./saveHistorySnapshot";
import type { SaveOrigin, SaveOutcome } from "./saveOutcome";
import { captureSave } from "./saveCapture";
import { saveError } from "@/utils/debug";
import { commandErrorDetailString, isCommandErrorCode }
  from "@/services/commands/commandError";

/** Pre-WI-14 sentinel prefix. Transitional only — delete with its tests once
 *  the CommandError ratchet (`scripts/check-command-error-ratchet.mjs`) is 0. */
const PARENT_MISSING_PREFIX = "PARENT_MISSING:";

/**
 * The vanished directory, or `null` if this failure is something else.
 *
 * Typed first (`code: "not-found"` + `detail.dir`), legacy prefix second. The
 * prefix match is what the typed path replaced: it could not tell a real
 * sentinel from an OS message starting with those characters, and any
 * rewording of the Rust error silently disabled the Save As recovery.
 */
function parseParentMissingError(error: unknown): string | null {
  if (isCommandErrorCode(error, "not-found")) return commandErrorDetailString(error, "dir");
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (!message || !message.startsWith(PARENT_MISSING_PREFIX)) return null;
  return message.slice(PARENT_MISSING_PREFIX.length);
}

/** Normalized save payload plus the line-ending/hard-break styles applied. */

/**
 * Resolve the on-save line-ending and hard-break styles from the document's
 * detected state plus user settings, and apply them to produce the bytes that
 * will be written to disk.
 *
 * @public — exported for the Phase 1 all-ingress matrix, which proves
 * round-trip fidelity against the REAL save pipeline rather than a re-implementation
 * that could drift from it.
 */
export function normalizeSaveContent(tabId: string, content: string): NormalizedSaveContent {
  const doc = useDocumentStore.getState().getDocument(tabId);
  const settings = useSettingsStore.getState();
  const targetLineEnding = resolveLineEndingOnSave(
    doc?.lineEnding ?? "unknown",
    settings.general.lineEndingsOnSave
  );
  const targetHardBreakStyle = resolveHardBreakStyle(
    doc?.hardBreakStyle ?? "unknown",
    settings.markdown.hardBreakStyleOnSave
  );
  const hardBreakNormalized = normalizeHardBreaks(content, targetHardBreakStyle);
  const normalized = normalizeLineEndings(hardBreakNormalized, targetLineEnding);
  // Decision D1: the editor buffer is BOM-free and `hasBom` remembers that the
  // file began with U+FEFF. The save is the READER of that flag — without this
  // line it had writers and no readers, and a BOM'd file lost its mark on the
  // first save.
  const output = doc?.hasBom ? `\u{FEFF}${normalized}` : normalized;
  return { output, targetLineEnding, targetHardBreakStyle };
}

/**
 * Map a failed write to user feedback, document state and the failure the
 * caller propagates, clearing the pending save first. Only a manual save
 * toasts.
 */
function handleWriteError(
  tabId: string,
  path: string,
  saveToken: ReturnType<typeof registerPendingSave>,
  saveType: SaveType,
  error: unknown
): SaveOutcome {
  // CRITICAL: Always clear pending save on failure to prevent stale entries.
  // Token ensures we only clear our own registration, not a newer save's.
  clearPendingSave(path, saveToken);
  saveError("Failed to save file:", error);

  // Parent directory vanished (renamed/deleted externally). Mark the doc
  // as missing so the calling Save handler routes through Save As — the
  // user can pick a new location in one click instead of staring at a
  // raw "No such file or directory" error.
  const missingDir = parseParentMissingError(error);
  if (missingDir !== null) {
    useDocumentStore.getState().markMissing(tabId);
    if (saveType === "manual") {
      toast.error(
        i18n.t("dialog:toast.failedToSaveParentMissing", { dir: missingDir }),
        { pin: true },
      );
    }
    return { ok: false, reason: "parent-missing", dir: missingDir };
  }

  // Manual saves toast; auto-saves stay quiet so a flaky disk doesn't pop
  // a notification every interval. The next manual save (or an external
  // signal like the file becoming missing) will surface the problem.
  if (saveType === "manual") {
    // Two-line toast: paths/permission details as the detail.
    // Raw error — errorDetail owns the normalization (commandErrorMessage,
    // so a typed rejection cannot render "[object Object]").
    toast.errorDetail(i18n.t("dialog:toast.failedToSaveGeneric"), error);
  }
  return { ok: false, reason: "write-failed", error };
}

/**
 * Serialized per path by `submitSave`. Everything here — the write, the store
 * update, and the history snapshot — belongs to one save and must not
 * interleave with another save to the same file.
 */
async function performSave(
  tabId: string,
  path: string,
  content: string,
  origin: SaveOrigin,
  claim: SaveTargetClaim
): Promise<SaveOutcome> {
  const { saveType } = origin;
  // Normalized at RUN time, not submission time: a queued save must use the
  // document's convention as of its turn, not as of when it was requested.
  const normalized = normalizeSaveContent(tabId, content);

  const ownership = resolveWritableFileOwnership(tabId, path);
  if (!ownership.ok) {
    if (saveType === "manual") showFileOwnershipConflictToast(path, ownership.conflicts);
    return { ok: false, reason: "ownership-conflict", conflicts: ownership.conflicts };
  }

  // Register pending save with content for content-based verification.
  // Token prevents overlapping saves from clearing each other's entries.
  const saveToken = registerPendingSave(path, normalized.output);

  try {
    await invoke("atomic_write_file", { path, content: normalized.output });
  } catch (error) {
    return handleWriteError(tabId, path, saveToken, saveType, error);
  }

  applyPostSaveState(tabId, path, content, normalized, saveToken, saveType, claim);
  await recordHistorySnapshot(path, normalized.output, saveType);
  captureSave(path, normalized.output, origin);

  return { ok: true, written: normalized.output };
}

/**
 * Submit one save: claim the document, then queue the write behind every
 * earlier save to the same path. The single entry both public doors use, so
 * no writer can reach the disk without the claim and the queue.
 */
function submitSave(
  tabId: string,
  path: string,
  content: string,
  origin: SaveOrigin
): Promise<SaveOutcome> {
  // Claimed HERE — at submission, outside the per-path queue. Path
  // serialization orders writes to one file; it cannot order two saves of one
  // DOCUMENT to different files, which is exactly the autosave-then-Save-As
  // case. Claiming at submission also means the user's
  // most recent choice wins even if its write finishes first.
  const claim = claimSaveTarget(tabId);
  return serializeByPath(normalizePath(path), () =>
    performSave(tabId, path, content, origin, claim)
  );
}

/**
 * Write `content` to `path`, serialized against every other save to that path.
 *
 * Concurrent saves to one file used to race. A debounced auto-save and a
 * manual save can be in flight together, and nothing ordered their
 * `atomic_write_file` calls — so the OLDER content could land second and win
 * on disk, after which `applyPostSaveState` recorded it as the saved snapshot
 * and the document showed clean against bytes the user never wrote. The
 * pending-save token protected cleanup bookkeeping; it never ordered writes.
 */
export function saveToPath(
  tabId: string,
  path: string,
  content: string,
  saveType: "manual" | "auto" = "manual"
): Promise<boolean> {
  return submitSave(tabId, path, content, { saveType }).then((outcome) => outcome.ok);
}

/**
 * The same save, for an AI client writing through the MCP bridge.
 *
 * `content` is editor-domain text (LF, BOM-free), exactly as for `saveToPath`.
 * The outcome says why a save wrote nothing, because the bridge has to tell
 * the client — and it is the bridge's only feedback channel: this door never
 * toasts. `toolName` (`document.write`, `workspace.save`, …) is recorded as
 * the write's provenance.
 */
export function saveToPathForMcp(
  tabId: string,
  path: string,
  content: string,
  toolName: string
): Promise<SaveOutcome> {
  return submitSave(tabId, path, content, { saveType: "mcp", toolName });
}
