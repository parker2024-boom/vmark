/**
 * Coherence scan-on-change (watcher wiring)
 *
 * Purpose: keep the coherence ledger's observed-external history current
 * by running a debounced kernel scan after workspace file events. Display
 * stays strictly pull-based (R14 — the breakdown never auto-opens);
 * only *reconciliation* rides the watcher, so external edits are already
 * honest history by the time anything pulls.
 *
 * Key decisions:
 *   - Trailing 3 s debounce; one scan in flight at a time (a burst of
 *     events collapses into one pass).
 *   - Fire-and-forget: scan failures log and never surface to the user
 *     (the next pull retries).
 *   - Listens ON the current window. The watcher addresses each `fs:changed`
 *     batch to the window that owns it; a listener with no target would be
 *     woken by every other window's watcher. Any batch for this window's
 *     workspace schedules a scan — a `rescan` batch with no changes included,
 *     since "the watcher lost track" is what a reconciliation pass is for.
 *
 * @coordinates-with src-tauri/src/coherence/scan.rs — the reconciliation pass
 * @coordinates-with useWindowFileWatcher.ts — starts the watcher that emits fs:changed
 * @coordinates-with capturePolicy.ts — the capture-on-save setting on the wire
 * @module services/coherence/scanOnChange
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { coherenceLog } from "@/utils/debug";
import { currentCapturePolicy } from "./capturePolicy";

const DEBOUNCE_MS = 3000;

/** What the scan trigger needs from Tauri. Injectable for tests. */
export interface ScanOnChangeDeps {
  /** Subscribe to an event addressed to THIS window. */
  listen: (event: string, handler: (event: unknown) => void) => Promise<() => void>;
  invoke: typeof invoke;
}

const tauriDeps: ScanOnChangeDeps = {
  listen: (event, handler) => getCurrentWebviewWindow().listen(event, handler),
  invoke,
};

/**
 * Start listening for workspace file changes; returns a disposer.
 * Injectable listen/invoke for tests.
 */
export function startCoherenceScanOnChange(deps: ScanOnChangeDeps = tauriDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scanning = false;
  let rerunAfter = false;
  let disposed = false;
  let unlisten: (() => void) | null = null;

  const runScan = async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root || disposed) return;
    if (scanning) {
      // An event landed mid-scan: run once more afterwards so nothing is
      // permanently lost.
      rerunAfter = true;
      return;
    }
    scanning = true;
    try {
      // Write-driven, so it obeys capture-on-save (WI-LX1.4): with the
      // setting off, a workspace without a ledger is never initialized here.
      await deps.invoke("coherence_scan", { workspaceRoot: root, policy: currentCapturePolicy() });
    } catch (error) {
      coherenceLog("scan-on-change failed (next pull retries):", error);
    } finally {
      scanning = false;
      if (rerunAfter && !disposed) {
        rerunAfter = false;
        void runScan();
      }
    }
  };

  const schedule = (event: unknown) => {
    if (disposed) return;
    // Only this window's workspace triggers a scan. The batch is
    // addressed to this window, but it carries its root, and a batch from the
    // watcher of a root the window has since left must not scan the new one.
    const root = useWorkspaceStore.getState().rootPath;
    const eventRoot = (event as { payload?: { rootPath?: string } })?.payload?.rootPath;
    if (!root || (typeof eventRoot === "string" && eventRoot !== root)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runScan();
    }, DEBOUNCE_MS);
  };

  void deps
    .listen("fs:changed", schedule)
    .then((un) => {
      if (disposed) un();
      else unlisten = un;
    })
    .catch((error) => coherenceLog("scan-on-change listen failed:", error));

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    unlisten?.();
  };
}
