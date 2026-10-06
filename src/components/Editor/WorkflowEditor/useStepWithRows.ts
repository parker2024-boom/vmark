/**
 * Purpose: A step's `with:` block as editable rows — local row state, the
 *   commit/removal plans that turn row edits into IRPatches, and the
 *   suggestions (known inputs, missing required inputs) drawn from the
 *   action's metadata.
 *
 * Key decisions:
 *   - Rows hold local state; blur commits via the pure plans in
 *     withRowPlans.ts (rename = remove + set, chains cancel intermediate
 *     keys, duplicate keys are rejected with an inline error). Removing a
 *     row cancels its queued sets and queues with.remove for its original
 *     key, so a deleted row never writes back on Save.
 *   - Metadata is idle for run steps; a failed fetch falls back to
 *     free-form rows so the form stays usable when the registry cannot
 *     reach GitHub.
 *   - The datalist id is keyed on jobId+stepIndex so forms rendered one
 *     after another get distinct ids.
 *
 * @coordinates-with src/components/Editor/WorkflowEditor/StepForm.tsx — the consumer
 * @coordinates-with src/components/Editor/WorkflowEditor/withRowPlans.ts — the commit/removal plans
 * @coordinates-with src/components/Editor/WorkflowEditor/useActionMetadata.ts — input schemas
 * @module components/Editor/WorkflowEditor/useStepWithRows
 */
import { useState } from "react";
import type { StepIR } from "@/lib/ghaWorkflow/types";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useActionMetadata } from "./useActionMetadata";
import {
  newWithRow,
  planWithRowCommit,
  planWithRowRemoval,
  withRowsFromStep,
  type WithRow,
} from "./withRowPlans";

interface StepWithRowsInput {
  jobId: string;
  stepIndex: number;
  step: StepIR;
  baseline: StepIR;
}

export function useStepWithRows({ jobId, stepIndex, step, baseline }: StepWithRowsInput) {
  const [withRows, setWithRows] = useState<WithRow[]>(withRowsFromStep(step));
  const queue = useWorkflowStore((s) => s.queuePatch);
  const cancel = useWorkflowStore((s) => s.cancelPatchForTarget);

  const metadataResult = useActionMetadata(step.uses);
  const inputs =
    metadataResult.state === "success"
      ? metadataResult.metadata.inputs
      : null;
  const setKeys = new Set(withRows.map((r) => r.key));
  const missingRequired = inputs
    ? Object.entries(inputs).filter(
        ([key, schema]) => schema.required && !setKeys.has(key),
      )
    : [];
  const datalistId = `workflow-form-with-keys-${jobId}-${stepIndex}`;
  const knownInputKeys = inputs ? Object.keys(inputs) : [];

  const addSuggestedKey = (key: string): void => {
    setWithRows((rows) =>
      rows.some((r) => r.key === key) ? rows : [...rows, newWithRow(key)],
    );
  };

  // Every OTHER row — duplicate detection + patch-ownership guards.
  const otherRows = (idx: number): WithRow[] =>
    withRows.filter((_, i) => i !== idx);

  const updateRow = (idx: number, patch: Partial<WithRow>): void => {
    setWithRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  };

  const commitWithRow = (idx: number): void => {
    const row = withRows[idx];
    const plan = planWithRowCommit({ jobId, stepIndex }, row, otherRows(idx), baseline.with);
    if (plan.kind === "noop") return;
    for (const patch of plan.cancels) cancel(patch);
    if (plan.kind === "duplicate") {
      updateRow(idx, { duplicateKey: true, committedKey: null });
      return;
    }
    for (const patch of plan.queues) queue(patch);
    updateRow(idx, { duplicateKey: false, committedKey: plan.committedKey });
  };

  const removeRow = (idx: number): void => {
    const plan = planWithRowRemoval({ jobId, stepIndex }, withRows[idx], otherRows(idx));
    for (const patch of plan.cancels) cancel(patch);
    for (const patch of plan.queues) queue(patch);
    setWithRows((rows) => rows.filter((_, i) => i !== idx));
  };

  const addRow = (): void => {
    setWithRows((rows) => [...rows, newWithRow()]);
  };

  return {
    withRows,
    metadataResult,
    inputs,
    setKeys,
    missingRequired,
    datalistId,
    knownInputKeys,
    addSuggestedKey,
    updateRow,
    commitWithRow,
    removeRow,
    addRow,
  };
}
