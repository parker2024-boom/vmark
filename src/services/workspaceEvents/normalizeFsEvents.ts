/**
 * Raw `fs:changed` → canonical semantic events (pure).
 *
 * Purpose: The deterministic core of the workspace event layer. Turns one raw
 *   Rust `fs:changed` batch into a scoped list of {@link SemanticWorkspaceEvent}
 *   — each change deduplicated by path, self-write echoes flagged, and the
 *   watcher's "I lost track of the tree" flag carried as a `rescan` event. Pure
 *   and collaborator-injected (mirrors services/windowClose/fsChangeHandlers) so
 *   it unit-tests without Tauri, React, or timers.
 *
 * Boundary discipline: this layer emits the *event*; it never decides the
 *   event's meaning or its reaction. Scope-filter + self-write flag + kind
 *   classification only.
 *
 * @coordinates-with utils/pendingSaves — hasPendingSave supplies the self-write flag
 * @module services/workspaceEvents/normalizeFsEvents
 */

import type {
  RawFsChangeBatch,
  RawFsChangeEvent,
  SemanticWorkspaceEvent,
  WorkspaceEventKind,
} from "./types";

/** Injected collaborators — kept out of the pure core so tests pass fakes. */
export interface NormalizeDeps {
  /** The window this normalizer serves; events from other watchers are dropped. */
  windowLabel: string;
  /** Active workspace root; `null` = not in workspace mode → everything dropped. */
  rootPath: string | null;
  /** Normalize a path for comparison and dedup. */
  normalizePath: (path: string) => string;
  /** True if a save VMark initiated is pending for this normalized path. */
  hasPendingSave: (normalizedPath: string) => boolean;
}

/** Map the Rust watcher's kind string onto the semantic vocabulary. */
function classifyKind(rawKind: string): WorkspaceEventKind {
  switch (rawKind) {
    case "create":
      return "created";
    case "remove":
      return "deleted";
    case "rename":
      return "renamed";
    // "modify" and any unknown kind: assume a content change — the safe
    // default (never silently drop a real edit).
    default:
      return "modified";
  }
}

/** True when `path` is the root itself or lives beneath it (boundary-safe). */
function isWithinRoot(path: string, root: string): boolean {
  if (path === root) return true;
  // A root that already ends in "/" (filesystem root "/", Windows drive root
  // "C:/") must not become "//" — that would reject every descendant.
  const prefix = root.endsWith("/") ? root : root + "/";
  return path.startsWith(prefix);
}

/**
 * Rename events arrive as flattened [old, new] pairs. Emit one `renamed` per
 * in-scope new path (carrying its old path). An unpaired trailing path (an
 * atomic-write rename that only reported its target) is emitted without a
 * previousPath so a consumer can probe it; its self-write flag still filters
 * our own saves.
 */
function collectRenames(
  paths: string[],
  root: string,
  out: Map<string, SemanticWorkspaceEvent>,
  normalizePath: (p: string) => string,
  hasPendingSave: (p: string) => boolean,
): void {
  for (let i = 0; i < paths.length; i += 2) {
    const paired = i + 1 < paths.length;
    const newPath = normalizePath(paired ? paths[i + 1] : paths[i]);
    const previousPath = paired ? normalizePath(paths[i]) : undefined;
    // Keep the rename if EITHER endpoint is in the workspace: a rename *into*
    // it (new in scope), *within* it (both), or *out* of it (old in scope — the
    // file left, so the tree must refresh and an open tab must be handled).
    const inScope =
      isWithinRoot(newPath, root) ||
      (previousPath !== undefined && isWithinRoot(previousPath, root));
    if (!inScope) continue;
    // No `previousPath` key on an unpaired rename event — the OS told us only
    // where the file landed, and `suppressUnchanged` reads the key's presence
    // to decide whether it can move a cache entry.
    out.set(newPath, {
      kind: "renamed",
      path: newPath,
      ...(previousPath !== undefined ? { previousPath } : {}),
      rootPath: root,
      selfWrite: hasPendingSave(newPath),
    });
  }
}

/**
 * Normalize one raw `fs:changed` batch: each change in the order the watcher
 * reported it, then — when the watcher says it lost track of the tree — one
 * `rescan` event for the root. Returns `[]` for a batch from another window or
 * while nothing is watched.
 *
 * Changes are normalized ONE AT A TIME. Two single-path renames that merely
 * share a batch must never be read as one [old, new] pair, and a
 * `create → remove → create` of one path must reach consumers as three events.
 */
export function normalizeFsBatch(
  batch: RawFsChangeBatch,
  deps: NormalizeDeps,
): SemanticWorkspaceEvent[] {
  const { windowLabel, rootPath, normalizePath } = deps;

  if (!rootPath) return [];
  // Defensive: a malformed runtime payload must never throw inside the listener.
  if (!batch || batch.watchId !== windowLabel) return [];

  const events: SemanticWorkspaceEvent[] = [];
  for (const change of Array.isArray(batch.changes) ? batch.changes : []) {
    if (!change || typeof change !== "object") continue;
    for (const event of normalizeFsEvents(
      { watchId: batch.watchId, rootPath: batch.rootPath, kind: change.kind, paths: change.paths },
      deps,
    )) {
      events.push(event);
    }
  }

  if (batch.rescan === true && typeof batch.rootPath === "string") {
    const root = normalizePath(rootPath);
    // A rescan of a root this window has since left says nothing about the
    // one it watches now.
    if (normalizePath(batch.rootPath) === root) {
      events.push({ kind: "rescan", path: root, rootPath: root, selfWrite: false });
    }
  }

  return events;
}

/**
 * Normalize ONE change into scoped, deduplicated semantic events. Returns `[]`
 * for a change from another window, outside the workspace, or with no in-scope
 * paths.
 */
export function normalizeFsEvents(
  event: RawFsChangeEvent,
  deps: NormalizeDeps,
): SemanticWorkspaceEvent[] {
  const { windowLabel, rootPath, normalizePath, hasPendingSave } = deps;

  if (!rootPath) return [];
  // Defensive: a malformed runtime payload must never throw inside the listener.
  if (
    !event ||
    event.watchId !== windowLabel ||
    !Array.isArray(event.paths) ||
    event.paths.length === 0
  ) {
    return [];
  }

  // Drop any non-string path elements (defensive against a malformed payload).
  const paths = event.paths.filter((p): p is string => typeof p === "string");
  if (paths.length === 0) return [];

  const root = normalizePath(rootPath);
  const kind = classifyKind(event.kind);
  const byPath = new Map<string, SemanticWorkspaceEvent>();

  if (kind === "renamed") {
    collectRenames(paths, root, byPath, normalizePath, hasPendingSave);
  } else {
    for (const rawPath of paths) {
      const path = normalizePath(rawPath);
      if (!isWithinRoot(path, root)) continue;
      byPath.set(path, { kind, path, rootPath: root, selfWrite: hasPendingSave(path) });
    }
  }

  return [...byPath.values()];
}
