/**
 * Lease event wiring — the real-world edges that make the browser
 * automation lease a control instead of a specification.
 *
 * Purpose: connect the browser lease service (`browserLease`) to its event sources:
 *   - `browser://user-input` — the native signal that a click or
 *     keydown reached a browser WKWebView. React cannot see input inside the
 *     native view (it is a sibling native layer, not DOM), so this is the only
 *     way "the human clicked the page" can reclaim the lease. Reclaim only when
 *     the AI actually holds the tab — ordinary browsing takes no lease.
 *   - `tabRemovalBus` — close/detach drops all lease state and cancels
 *     in-flight work (never leave a step running against a destroyed surface).
 *
 * Chrome-side reclaim (toolbar/omnibox interaction, the indicator button) calls
 * the lease service directly from `BrowserChrome`; it needs no wiring here.
 *
 * Started once from `useCommandBootstrap` (the `startGrantSync` pattern).
 *
 * @coordinates-with services/browser/lease.ts — the lease service being driven
 * @coordinates-with src-tauri browser user-input monitor — emits browser://user-input
 * @coordinates-with stores/tabRemovalBus.ts — close/detach notifications
 * @module services/browser/browserLeaseWiring
 */

import { listen } from "@tauri-apps/api/event";
import { onTabRemoved } from "@/stores/tabRemovalBus";
import { browserLease } from "./lease";

function tabIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const id = (payload as Record<string, unknown>).tabId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Attach the lease's event sources. Returns a stop function. */
export function startBrowserLeaseWiring(): () => void {
  let disposed = false;
  let unlistenInput: (() => void) | null = null;

  void listen("browser://user-input", (event) => {
    const tabId = tabIdOf(event.payload);
    if (tabId === null) return;
    // Ordinary browsing takes no lease; only an AI tenure is reclaimed.
    if (browserLease.currentHolder(tabId) === "ai") browserLease.reclaimForHuman(tabId);
  }).then((stop) => {
    if (disposed) stop();
    else unlistenInput = stop;
  });

  const offTabRemoved = onTabRemoved((_windowLabel, tabId) => {
    browserLease.removeTab(tabId);
  });

  return () => {
    disposed = true;
    unlistenInput?.();
    unlistenInput = null;
    offTabRemoved();
  };
}
