/**
 * Workspace event layer — shared vocabulary.
 *
 * Purpose: The canonical, deduplicated event types the workspace event layer
 *   emits, unifying the ad-hoc `FsChangeEvent` shapes previously re-declared per
 *   consumer (useFileTree, useExternalFileChanges). This layer owns the *event*;
 *   deciding what a change *means* (staleness, recompile) and what to *do* about
 *   it belongs to consumers — never here.
 *
 * @coordinates-with src-tauri/src/watcher/batch.rs — the Rust twin of the raw batch types
 * @module services/workspaceEvents/types
 */

/**
 * One change inside a watcher batch. `kind` is the watcher's string
 * ("create" | "modify" | "remove" | "rename"); `paths` are absolute, and a
 * rename the OS reported as a pair carries [old, new].
 */
interface RawFsChange {
  /** Watcher kind string. */
  kind: string;
  /** Changed absolute paths (rename → [old, new] when the OS paired them). */
  paths: string[];
}

/**
 * The raw `fs:changed` payload: every change one Rust watcher saw in one
 * window of time, in the order the OS reported them. Addressed to the window
 * that owns the watcher.
 */
export interface RawFsChangeBatch {
  /** Watcher id — the owning window's label. */
  watchId: string;
  /** The directory the watcher covers. */
  rootPath: string;
  /** The changes, oldest first. */
  changes: RawFsChange[];
  /**
   * True when the watcher lost track of the tree (the OS dropped events, or
   * the watcher reported an error): `changes` may be incomplete.
   */
  rescan: boolean;
}

/** One change of a batch together with the watcher it came from. */
export interface RawFsChangeEvent extends RawFsChange {
  /** Watcher id — the owning window's label. */
  watchId: string;
  /** The directory the watcher covers. */
  rootPath: string;
}

/**
 * Semantic classification of a workspace event. The first four name what
 * happened to one path; `rescan` says the watcher lost track of the tree, so
 * anything under the root may have changed without an event of its own.
 */
export type WorkspaceEventKind = "created" | "modified" | "deleted" | "renamed" | "rescan";

/**
 * One normalized, in-scope workspace change — the layer's output unit.
 */
export interface SemanticWorkspaceEvent {
  /** What happened to the path. */
  kind: WorkspaceEventKind;
  /**
   * Normalized absolute path of the affected file. For `rescan`, the watched
   * root itself.
   */
  path: string;
  /**
   * For `renamed`, the normalized old path. Absent for other kinds and for an
   * unpaired rename (an atomic-write rename that only reported its target).
   */
  previousPath?: string;
  /** The (normalized) workspace root the event was scoped against. */
  rootPath: string;
  /**
   * True when this change is the echo of a save VMark itself initiated — a
   * pending save is registered for the path. Consumers skip self-writes for
   * reload/notify purposes.
   */
  selfWrite: boolean;
}
