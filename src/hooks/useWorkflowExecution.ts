/**
 * useWorkflowExecution — the window's workflow-event owner, and the run commands.
 *
 * Purpose: split the two things a workflow run needs:
 *   - `useWorkflowEventLifecycle` HOLDS the window's one subscription to the
 *     runner's events (`services/workflow/workflowRunEvents.ts`) while it is
 *     mounted. The approval dialog — always mounted in a document window —
 *     is its one caller. Every run panel used to subscribe its own copy, so
 *     each frame was handled once per panel.
 *   - `startWorkflowRun`, `cancelWorkflowRun` and `respondWorkflowApproval`
 *     are plain commands for panels. They subscribe nothing.
 *
 * Key decisions:
 *   - A start registers its execution id AND the tab that started it in one
 *     store write, before `run_workflow` resolves (via
 *     `dispatchWorkflowRun`). Ownership bound after the start resolved left a
 *     window in which a panel's Cancel could target another pane's or a
 *     genie's run, and a panel remounted mid-start saw its own run as
 *     somebody else's.
 *   - Cancel names an EXPLICIT execution id — the one the caller owns — never
 *     "whatever the store holds now".
 *   - A second start while a run is registered is refused before the store is
 *     touched, so the live run keeps its id and its events.
 *
 * @coordinates-with services/workflow/workflowRunEvents.ts — the subscription
 * @coordinates-with services/workflow/dispatchWorkflowRun.ts — the run_workflow transaction
 * @coordinates-with services/workflow/providerPayload.ts — the provider block
 * @coordinates-with components/WorkflowApproval/ApprovalDialog.tsx — the lifecycle's one mount
 * @coordinates-with components/Editor/WorkflowPanel/useWorkflowRunControls.ts — the panels' Run/Cancel
 * @coordinates-with src-tauri/src/workflow/commands.rs — invoke targets
 * @module hooks/useWorkflowExecution
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

import { workflowProviderPayload } from "@/services/workflow/providerPayload";
import { dispatchWorkflowRun } from "@/services/workflow/dispatchWorkflowRun";
import { retainWorkflowEvents } from "@/services/workflow/workflowRunEvents";

export interface RunOptions {
  /** YAML body of the workflow file. */
  yaml: string;
  /** Workspace root for path validation in action steps. */
  workspaceRoot: string;
  /** Optional env vars passed to ${VAR} / ${{ env.X }} resolution. */
  env?: Record<string, string>;
  /** The tab whose panel is starting the run; it owns the run from registration. */
  ownerTabId?: string;
}

/** Hold the window's workflow-event subscription while mounted. Mount ONCE. */
export function useWorkflowEventLifecycle(): void {
  useEffect(() => retainWorkflowEvents(), []);
}

/**
 * Start a workflow run and return its execution id. Refused — thrown, for the
 * caller to show — while another run is registered, or when no event owner is
 * mounted to route the run's frames.
 */
export async function startWorkflowRun({
  yaml,
  workspaceRoot,
  env,
  ownerTabId,
}: RunOptions): Promise<string> {
  const outcome = await dispatchWorkflowRun({
    yaml,
    workspaceRoot,
    env,
    provider: workflowProviderPayload(),
    owner: ownerTabId === undefined ? undefined : { tabId: ownerTabId, source: yaml },
  });
  if (outcome.status === "already-running") {
    throw new Error("A workflow is already running in this window");
  }
  return outcome.returnedId;
}

/** Ask the runner to stop `executionId` — the run the caller owns. */
export async function cancelWorkflowRun(executionId: string): Promise<void> {
  await invoke("cancel_workflow", { executionId });
}

/** Deliver the user's verdict on one step's approval request. */
export async function respondWorkflowApproval(
  executionId: string,
  stepId: string,
  approved: boolean,
): Promise<void> {
  await invoke("respond_workflow_approval", { executionId, stepId, approved });
}
