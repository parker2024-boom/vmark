/**
 * The preview slice's transitions — pure functions over `PreviewSlice`.
 *
 * Purpose: `workflowStore.ts` is the store's WIRING; what a run's panel state
 * looks like after an event is a separate concern with no Zustand in it, and it
 * had grown to the point of pushing that file past its size cap.
 * Same split `workflowEditQueue.ts` already makes for the patch queue.
 *
 * Everything here returns the SAME slice reference when nothing changes, which
 * is how the store expresses a no-op `set` without each caller restating it.
 *
 * @coordinates-with src/stores/workflowStore.ts — the only consumer
 * @module stores/workflowPreviewSlice
 */
import type { StepStatusEntry, WorkflowGraph } from "@/lib/workflow/types";

/** How a run ended, once `executionId` is back to null. */
export type WorkflowRunOutcome = "completed" | "failed" | "cancelled";

/**
 * One markdown-surface document's live preview: the
 * graph its Source editor parsed, the parse error, and whether its side panel
 * is open. Keyed by tab, because two Source editors in a split each parse
 * their own file — a single slot let them overwrite each other, and either
 * one's teardown closed the other's panel.
 */
export interface DocPreview {
  panelOpen: boolean;
  graph: WorkflowGraph | null;
  parseError: string | null;
}

/** Who started a run: the tab whose panel did, and the YAML it ran. */
export interface RunOwner {
  tabId: string;
  source: string;
}

export interface PreviewSlice {
  /** Per-tab previews; a tab with nothing to show has no entry. */
  docs: Record<string, DocPreview>;
  executionId: string | null;
  stepStatuses: Record<string, StepStatusEntry>;
  /** How the run that just ended ended; null since the last `setExecution`. */
  lastRunOutcome: WorkflowRunOutcome | null;
  /** Which run just ended — the key its pre-run snapshot is found by. */
  lastExecutionId: string | null;
  /**
   * The tab whose panel started the current (or last) run, or null for an
   * unowned run — a workflow genie's. Registered WITH the run, in the same
   * write. Only that tab's panel paints the run's statuses,
   * offers Cancel, and offers the restore (WI-LX2.1).
   */
  runTabId: string | null;
  /**
   * The YAML the owned run executed. Statuses are painted only while the
   * owning tab still holds exactly this text: after an edit, a step
   * sharing an old id is not the step that succeeded or failed.
   */
  runSource: string | null;
  /** The last run whose snapshot was FULLY restored — never offered again. */
  restoredExecutionId: string | null;
  /**
   * The finished run a pending start set aside, put back if the backend
   * refuses the start, and dropped once the start is admitted.
   */
  displacedRun: FinishedRun | null;
}

/** What a finished run leaves for its panel: results, outcome, owner, text. */
type FinishedRun = Pick<
  PreviewSlice,
  "stepStatuses" | "lastRunOutcome" | "lastExecutionId" | "runTabId" | "runSource"
>;

const NO_RUN: FinishedRun = {
  stepStatuses: {},
  lastRunOutcome: null,
  lastExecutionId: null,
  runTabId: null,
  runSource: null,
};

export const initialPreview: PreviewSlice = {
  docs: {},
  executionId: null,
  ...NO_RUN,
  restoredExecutionId: null,
  displacedRun: null,
};

const NO_DOC_PREVIEW: DocPreview = Object.freeze({ panelOpen: false, graph: null, parseError: null });

/** `tabId`'s preview, or the shared empty one — a stable reference for selectors. */
export function docPreview(slice: PreviewSlice, tabId: string | null): DocPreview {
  return (tabId !== null && slice.docs[tabId]) || NO_DOC_PREVIEW;
}

/**
 * Patch `tabId`'s preview; one left with nothing to show is dropped, and a
 * patch that changes nothing returns the SAME slice (a re-parse re-opens an
 * already-open panel on every keystroke).
 */
function patchDoc(slice: PreviewSlice, tabId: string, patch: Partial<DocPreview>): PreviewSlice {
  const current = docPreview(slice, tabId);
  const next = { ...current, ...patch };
  if (
    next.panelOpen === current.panelOpen &&
    next.graph === current.graph &&
    next.parseError === current.parseError
  ) {
    return slice;
  }
  const docs = { ...slice.docs };
  if (!next.panelOpen && next.graph === null && next.parseError === null) delete docs[tabId];
  else docs[tabId] = next;
  return { ...slice, docs };
}

export function setPanelOpen(slice: PreviewSlice, tabId: string, panelOpen: boolean): PreviewSlice {
  return patchDoc(slice, tabId, { panelOpen });
}

/**
 * Replace `tabId`'s graph.
 *
 * The run SURVIVES — its id (clearing it has been proposed, and the code
 * refutes it) and its step statuses. The only production caller is the source
 * pane's debounced re-parse, which fires on open, on every keystroke in a
 * workflow file and on leaving it — including while a run is in flight.
 * `finishExecution` matches on the id, so clearing it would leave a running
 * execution unfinishable; clearing the statuses wiped a live run's progress on
 * every keystroke. Statuses belong to the run, and whether they are painted
 * over a graph is decided against `runSource`, the text that ran. A step
 * SELECTION is not store state at all: it is the panel's, tied to the graph
 * object it was made on, so a re-parse drops it by construction.
 */
export function setGraph(
  slice: PreviewSlice,
  tabId: string,
  graph: WorkflowGraph | null,
  error?: string,
): PreviewSlice {
  return patchDoc(slice, tabId, { graph, parseError: error ?? null });
}

function finishedRunOf(slice: PreviewSlice): FinishedRun {
  const { stepStatuses, lastRunOutcome, lastExecutionId, runTabId, runSource } = slice;
  return { stepStatuses, lastRunOutcome, lastExecutionId, runTabId, runSource };
}

/**
 * Register a new run — with its `owner` when a panel started it, in the SAME
 * write — or roll one back.
 *
 * Registration happens BEFORE the backend admits the run, so the finished run
 * it replaces is set aside rather than discarded: a start the backend refuses
 * (engine off, bad YAML, snapshot failed) rolls back with `null` and gets that
 * run back — its outcome, its owner, and with them its restore offer. Without
 * a set-aside run, `null` leaves nothing owned.
 */
export function setExecution(
  slice: PreviewSlice,
  executionId: string | null,
  owner?: RunOwner,
): PreviewSlice {
  if (executionId === null) {
    return { ...slice, executionId: null, ...(slice.displacedRun ?? NO_RUN), displacedRun: null };
  }
  const displacedRun = slice.executionId === null ? finishedRunOf(slice) : null;
  const owned = owner ? { runTabId: owner.tabId, runSource: owner.source } : {};
  return { ...slice, executionId, ...NO_RUN, ...owned, displacedRun };
}

/**
 * End `executionId`, KEEPING its step statuses.
 *
 * `setExecution(null)` discarded every step result at the moment the run ended
 * — the canvas lost its success/failure colouring exactly when the user wanted
 * to read it — and made completed, failed and cancelled indistinguishable.
 * Request-scoped: a terminal frame from an earlier run cannot end a newer one,
 * and returns the slice unchanged so the store can skip the write entirely.
 * The run was admitted, so whatever it displaced is gone for good.
 */
export function finishExecution(
  slice: PreviewSlice,
  executionId: string,
  outcome: WorkflowRunOutcome,
): PreviewSlice {
  if (slice.executionId !== executionId) return slice;
  return {
    ...slice,
    executionId: null,
    lastRunOutcome: outcome,
    lastExecutionId: executionId,
    displacedRun: null,
  };
}

/** Record that `executionId`'s snapshot was restored in full, so no panel —
 *  including one mounted later — offers the same restore again. */
export function markRunRestored(slice: PreviewSlice, executionId: string): PreviewSlice {
  return { ...slice, restoredExecutionId: executionId };
}

export function setStepStatus(
  slice: PreviewSlice,
  stepId: string,
  entry: StepStatusEntry,
): PreviewSlice {
  return { ...slice, stepStatuses: { ...slice.stepStatuses, [stepId]: entry } };
}

export function resetStatuses(slice: PreviewSlice): PreviewSlice {
  return { ...slice, stepStatuses: {} };
}
