/**
 * Panels whose code loads the first time they are shown.
 *
 * Purpose: let the Settings window paint with the one section it opens on,
 * instead of evaluating every section's panel before it can draw anything.
 *
 * Key decisions:
 *   - Only a successful import is remembered. A failed one is imported again
 *     on the next request, so a retry is a real retry (`React.lazy` would
 *     replay the cached rejection for as long as the lazy object lives).
 *   - Concurrent requests for a panel share one import.
 *   - A status, not Suspense. Settings search stacks every panel and counts
 *     the visible rows in a layout effect; that count is right only when all
 *     the panels mount in the same commit. `usePanels` therefore reports
 *     `ready` once EVERY requested panel is loaded, and a caller renders them
 *     together or not at all.
 *
 * @coordinates-with pages/settings/panels.ts — the settings panels built on this
 * @coordinates-with pages/settings/SettingsContent.tsx — renders by the status
 * @module pages/settings/panelCache
 */
import { useEffect, useState, type ComponentType } from "react";
import { appError } from "@/utils/debug";

/** A loaded panel, with the id it was asked for by. */
interface LoadedPanel<K extends string> {
  id: K;
  Component: ComponentType;
}

export interface PanelCache<K extends string> {
  /** The panels for `ids`, in that order, when every one is loaded; else null. */
  peek(ids: readonly K[]): LoadedPanel<K>[] | null;
  /** Load whichever of `ids` is not loaded yet. Rejects when an import fails. */
  load(ids: readonly K[]): Promise<void>;
  /** Names this cache in the log line of a failed import. */
  readonly label: string;
}

/** A cache over `loaders`, one import thunk per panel id. */
export function createPanelCache<K extends string>(
  label: string,
  loaders: Record<K, () => Promise<ComponentType>>,
): PanelCache<K> {
  const loaded = new Map<K, ComponentType>();
  const inFlight = new Map<K, Promise<void>>();

  const loadOne = (id: K): Promise<void> => {
    if (loaded.has(id)) return Promise.resolve();
    const running = inFlight.get(id);
    if (running) return running;
    const started = loaders[id]()
      .then((component) => {
        loaded.set(id, component);
      })
      .finally(() => {
        inFlight.delete(id);
      });
    inFlight.set(id, started);
    return started;
  };

  return {
    label,
    peek(ids) {
      const panels: LoadedPanel<K>[] = [];
      for (const id of ids) {
        const Component = loaded.get(id);
        if (Component === undefined) return null;
        panels.push({ id, Component });
      }
      return panels;
    },
    async load(ids) {
      await Promise.all(ids.map(loadOne));
    },
  };
}

/** What `usePanels` knows about the panels it was asked for. */
export type PanelLoad<K extends string> =
  | { status: "ready"; panels: readonly LoadedPanel<K>[] }
  | { status: "loading" }
  | { status: "failed"; retry: () => void };

/** Joins panel ids into a request key; no id contains a line break. */
const KEY_SEPARATOR = "\n";

/** A request that ended in a failed import: which panels, on which attempt. */
interface Failure {
  key: string;
  attempt: number;
}

/**
 * The panels for `ids`, loading the missing ones.
 *
 * `ready` on the first render when all are already loaded, so revisiting a
 * section never passes through `loading`.
 */
export function usePanels<K extends string>(cache: PanelCache<K>, ids: readonly K[]): PanelLoad<K> {
  // Callers pass a fresh array on every render; the joined ids are the stable
  // identity of the request, and the effect reads the ids back out of them.
  const key = ids.join(KEY_SEPARATOR);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Bumped when a load lands, to re-read the cache.
  const [, setArrivals] = useState(0);
  const panels = cache.peek(ids);
  const ready = panels !== null;

  useEffect(() => {
    if (ready) return;
    let current = true;
    const wanted = key === "" ? [] : (key.split(KEY_SEPARATOR) as K[]);
    cache.load(wanted).then(
      () => {
        if (current) setArrivals((count) => count + 1);
      },
      (error: unknown) => {
        appError(`${cache.label} panel failed to load:`, error);
        if (current) setFailure({ key, attempt });
      },
    );
    return () => {
      current = false;
    };
  }, [cache, key, attempt, ready]);

  // A failure belongs to the request that failed. Asked for something else, it
  // is forgotten — so coming back to the same panels loads them again rather
  // than replaying the old failure.
  if (failure !== null && failure.key !== key) setFailure(null);

  if (panels !== null) return { status: "ready", panels };
  if (failure !== null && failure.key === key && failure.attempt === attempt) {
    return { status: "failed", retry: () => setAttempt((count) => count + 1) };
  }
  return { status: "loading" };
}
