/**
 * The window's ONE subscription to the workflow runner's events.
 *
 * Purpose: route `workflow:step-update`, `workflow:complete` and
 * `workflow:approval-request` into the workflow store — once per window, not
 * once per mounted panel. Every run panel and the
 * always-mounted approval dialog used to subscribe its own copy through
 * `useWorkflowExecution`, so every frame was handled several times.
 *
 * Key decisions:
 *   - **Retained, not owned by a component.** `retainWorkflowEvents()` counts
 *     holders; the first subscribes, the last one's release unsubscribes. The
 *     window's holder is the approval dialog (`useWorkflowEventLifecycle`);
 *     panels only START and CANCEL runs and hold nothing.
 *   - **A start never subscribes.** `workflowEventsReady()` resolves once the
 *     held subscription is live — awaiting one in flight, retrying one that
 *     failed — and REJECTS when nothing holds it: a run started then would
 *     emit frames nobody routes, and a quiet start would hide that.
 *   - Subscription is TRANSACTIONAL: a failed `listen` releases the ones
 *     already acquired. A subscription that completes after its last holder
 *     left drops itself.
 *   - Every frame is matched against the CURRENT execution id by exact,
 *     non-null equality; completion keeps the step statuses and records
 *     how the run ended.
 *
 * @coordinates-with hooks/useWorkflowExecution.ts — the lifecycle hook and the run commands
 * @coordinates-with services/workflow/dispatchWorkflowRun.ts — awaits `workflowEventsReady`
 * @coordinates-with stores/workflowStore.ts — where the frames land
 * @module services/workflow/workflowRunEvents
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { workflowError } from "@/utils/debug";
import {
  useWorkflowStore,
  type ApprovalRequestPayload,
  type WorkflowRunOutcome,
} from "@/stores/workflowStore";

interface StepUpdateEvent {
  executionId: string;
  stepId: string;
  status: "running" | "success" | "error" | "skipped";
  output?: string;
  error?: string;
  duration?: number;
}

interface CompleteEvent {
  executionId: string;
  /** The store's own terminal vocabulary, so wire and state cannot drift. */
  status: WorkflowRunOutcome;
}

let holders = 0;
let live: UnlistenFn[] | null = null;
let inFlight: Promise<void> | null = null;
/** Bumped by `resetWorkflowEvents`, so a subscription from before it drops itself. */
let generation = 0;

function isCurrentExecution(executionId: string): boolean {
  return useWorkflowStore.getState().preview.executionId === executionId;
}

/** Drop a set of listeners, tolerating one that is already gone. */
function release(fns: readonly UnlistenFn[]): void {
  for (const fn of fns) {
    try {
      fn();
    } catch {
      // listener already cleaned up
    }
  }
}

async function acquire(): Promise<UnlistenFn[]> {
  const store = useWorkflowStore;
  const acquired: UnlistenFn[] = [];
  try {
    acquired.push(
      await listen<StepUpdateEvent>("workflow:step-update", ({ payload }) => {
        if (!isCurrentExecution(payload.executionId)) return;
        // Only the facts this frame reports: a running step has no duration
        // or error yet, and `undefined` keys would claim they were empty.
        store.getState().setStepStatus(payload.stepId, {
          status: payload.status,
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          ...(payload.error !== undefined ? { error: payload.error } : {}),
          ...(payload.duration !== undefined ? { duration: payload.duration } : {}),
        });
      }),
    );
    acquired.push(
      await listen<CompleteEvent>("workflow:complete", ({ payload }) => {
        if (!isCurrentExecution(payload.executionId)) return;
        store.getState().finishExecution(payload.executionId, payload.status);
        // The run is over: dismiss ITS pending approval, and only that one.
        const pending = store.getState().approval.pending;
        if (pending && pending.executionId === payload.executionId) {
          store.getState().dismissApproval(pending);
        }
      }),
    );
    acquired.push(
      await listen<ApprovalRequestPayload>("workflow:approval-request", ({ payload }) => {
        if (!isCurrentExecution(payload.executionId)) return;
        store.getState().enqueueApproval(payload);
      }),
    );
    return acquired;
  } catch (error) {
    release(acquired);
    throw error;
  }
}

/** Subscribe if held and not yet live; the one in flight otherwise. */
function ensure(): Promise<void> {
  if (live) return Promise.resolve();
  if (inFlight) return inFlight;
  const started = generation;
  const attempt = acquire()
    .then((fns) => {
      // Every holder left while this was registering.
      if (holders === 0 || started !== generation) release(fns);
      else live = fns;
    })
    .catch((error: unknown) => {
      workflowError("Failed to subscribe to workflow events:", error);
      throw error;
    })
    .finally(() => {
      if (inFlight === attempt) inFlight = null;
    });
  inFlight = attempt;
  return attempt;
}

/**
 * Hold the window's workflow-event subscription. Returns the release, which
 * is idempotent: a second call cannot drop another holder's hold.
 */
export function retainWorkflowEvents(): () => void {
  holders += 1;
  ensure().catch(() => {
    // Logged in `ensure`; the next `workflowEventsReady()` retries.
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0 && live) {
      release(live);
      live = null;
    }
  };
}

/**
 * Resolve once the held subscription is live — the precondition for starting
 * a run, whose first frames can arrive before `run_workflow` resolves.
 * Rejects when nothing holds the events; never subscribes on its own.
 */
export function workflowEventsReady(): Promise<void> {
  if (holders === 0) {
    return Promise.reject(
      new Error("No workflow event owner is mounted: a run's events would go unrouted"),
    );
  }
  return ensure();
}

/** Drop every hold and listener. Tests only — module state outlives a test. */
export function resetWorkflowEvents(): void {
  if (live) release(live);
  live = null;
  inFlight = null;
  holders = 0;
  generation += 1;
}
