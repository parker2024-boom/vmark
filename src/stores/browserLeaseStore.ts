/**
 * Browser automation lease — state.
 *
 * Purpose: the per-tab lease records (who drives the page, and the takeover
 * epoch) and the per-tab canceller for the AI's in-flight driver step. React
 * subscribes here for the "AI is controlling" indicators.
 *
 * Key decisions:
 *   - Data only, no actions. Every transition goes through the lease service
 *     (`services/browser/lease.ts`), because a transition runs a canceller —
 *     foreign code that aborts a driver step — and the ORDER matters: the
 *     record is committed first, the canceller runs after, outside any `set`.
 *     A store action could not express that without becoming the service.
 *   - Write only through the lease service; read through selectors here.
 *
 * @coordinates-with services/browser/lease.ts — the only writer
 * @coordinates-with services/browser/leaseTransitions.ts — the record shapes
 * @module stores/browserLeaseStore
 */

import { create } from "zustand";
import type { Cancellers, Leases } from "@/services/browser/leaseTransitions";

export interface BrowserLeaseState {
  /** Per-tab lease record, keyed by browser tab id. */
  leases: Leases;
  /** Per-tab canceller for the AI's in-flight driver step, if any. */
  inflightCancel: Cancellers;
}

const initialState: BrowserLeaseState = { leases: {}, inflightCancel: {} };

/** The per-tab automation lease state (R11). Use selectors, not destructuring. */
export const useBrowserLeaseStore = create<BrowserLeaseState>(() => initialState);

/** Drop every tab's lease and canceller — for tests. */
export function resetBrowserLeaseStore(): void {
  useBrowserLeaseStore.setState(initialState, true);
}
