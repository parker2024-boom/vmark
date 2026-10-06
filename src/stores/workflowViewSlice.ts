/**
 * The canvas view slice's transitions — pure functions over `ViewSlice`.
 *
 * Split from `workflowStore.ts` for the same reason as the preview slice:
 * the store file is the wiring, and a 156-line initializer
 * carrying five domains had pushed it past the ~300-line cap.
 *
 * Two kinds of state live here and reset differently: the SELECTION belongs
 * to one document and is cleared when the workbench switches documents; the
 * LAYOUT DIRECTION is how the user likes to read a workflow, toggled from the
 * canvas's control strip, and survives the switch (WI-LX2.4).
 *
 * A matrix-expansion toggle used to live here too (`toggleMatrix` /
 * `expandedMatrices`). Nothing rendered an expanded matrix — the graph has one
 * node per job and the node already shows the combination count — so the state
 * was deleted rather than wired to a control that would do nothing.
 *
 * @coordinates-with src/stores/workflowStore.ts — the only consumer
 * @module stores/workflowViewSlice
 */
import type { LayoutDirection } from "@/lib/ghaWorkflow/render/layout";

export interface ViewSlice {
  selectedJobId: string | null;
  selectedStepId: string | null;
  layoutDirection: LayoutDirection;
}

export const initialView: ViewSlice = {
  selectedJobId: null,
  selectedStepId: null,
  layoutDirection: "TD",
};

export function selectJob(slice: ViewSlice, jobId: string): ViewSlice {
  return { ...slice, selectedJobId: jobId, selectedStepId: null };
}

export function selectStep(slice: ViewSlice, jobId: string, stepId: string): ViewSlice {
  return { ...slice, selectedJobId: jobId, selectedStepId: stepId };
}

export function clearSelection(slice: ViewSlice): ViewSlice {
  return { ...slice, selectedJobId: null, selectedStepId: null };
}

export function setLayoutDirection(slice: ViewSlice, layoutDirection: LayoutDirection): ViewSlice {
  return { ...slice, layoutDirection };
}

/** A document switch: forget the selection, keep the reading direction. */
export function resetView(slice: ViewSlice): ViewSlice {
  return { ...initialView, layoutDirection: slice.layoutDirection };
}
