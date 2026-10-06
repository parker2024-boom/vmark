/**
 * Workflow dispatch transaction
 *
 * Purpose: the ONE place that starts a `run_workflow` — shared by the
 * workflow panel (`startWorkflowRun`, useWorkflowExecution.ts) and workflow genies
 * (`useGenieInvocation`). Both used to carry their own copy of this
 * transaction, and adding `capturePolicy` (WI-LX1.4) had to be done twice;
 * any future field would have had to be as well.
 *
 * Pipeline: wait for the window's event subscription → generate id → refuse
 *   if a run is registered → claim the store slot (with its owner) → invoke
 *   `run_workflow` → on rejection, roll back THIS claim only.
 *
 * Key decisions:
 *   - The id is generated and registered BEFORE invoking (C2): a fast
 *     workflow can emit step-update/complete events before `invoke` resolves,
 *     and those are routable only once the store holds the id.
 *   - LISTENERS FIRST, for both entry points: the window's one event
 *     subscription (`workflowRunEvents.ts`) must be live before anything is
 *     claimed. The genie path used to skip this. With no event owner mounted
 *     the dispatch is refused loudly rather than started unobserved.
 *   - One run per window, checked and claimed with no await between, so two
 *     calls in one tick cannot both pass. A refusal is an
 *     outcome, not an error — each caller decides how to surface it.
 *   - The claim carries the run's OWNER when a panel started it:
 *     one store write registers the id and the tab together, and `invoke` is
 *     issued in the same synchronous block, so no panel ever sees a run that
 *     exists but belongs to nobody.
 *   - A rejected invoke clears the slot only while it still holds THIS id:
 *     a run registered after this one must not be wiped by its
 *     failure. The original rejection is rethrown unchanged (it is a typed
 *     `CommandError` the caller renders).
 *   - Provider resolution and toasts stay in the callers; this module owns
 *     only what both entry points must do identically.
 *
 * @coordinates-with hooks/useWorkflowExecution.ts — panel runs
 * @coordinates-with services/workflow/workflowRunEvents.ts — the subscription a dispatch waits for
 * @coordinates-with hooks/useGenieInvocation.ts — workflow genies
 * @coordinates-with services/coherence/capturePolicy.ts — the policy each run carries
 * @coordinates-with src-tauri/src/workflow/commands.rs — `run_workflow`
 * @module services/workflow/dispatchWorkflowRun
 */
import { invoke } from "@tauri-apps/api/core";

import { currentCapturePolicy } from "@/services/coherence/capturePolicy";
import { useWorkflowStore, type RunOwner } from "@/stores/workflowStore";
import type { WorkflowProviderPayload } from "./providerPayload";
import { workflowEventsReady } from "./workflowRunEvents";

export interface WorkflowRunRequest {
  yaml: string;
  workspaceRoot: string;
  env?: Record<string, string> | undefined;
  provider: WorkflowProviderPayload | null;
  /** The panel starting the run; absent for a workflow genie's (unowned). */
  owner?: RunOwner | undefined;
}

export type WorkflowDispatchOutcome =
  | { status: "dispatched"; returnedId: string }
  | { status: "already-running" };

function newExecutionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Register a fresh execution id (and its owner), then run the workflow under it. */
export async function dispatchWorkflowRun(
  request: WorkflowRunRequest,
): Promise<WorkflowDispatchOutcome> {
  await workflowEventsReady();
  const id = newExecutionId();
  if (useWorkflowStore.getState().preview.executionId !== null) {
    return { status: "already-running" };
  }
  useWorkflowStore.getState().setExecution(id, request.owner);
  try {
    const returnedId = await invoke<string>("run_workflow", {
      yaml: request.yaml,
      env: request.env ?? {},
      workspaceRoot: request.workspaceRoot,
      provider: request.provider,
      executionId: id,
      // The capture-on-save setting for this run's save-file steps (WI-LX1.4).
      capturePolicy: currentCapturePolicy(),
    });
    return { status: "dispatched", returnedId };
  } catch (err) {
    const store = useWorkflowStore.getState();
    if (store.preview.executionId === id) store.setExecution(null);
    throw err;
  }
}
