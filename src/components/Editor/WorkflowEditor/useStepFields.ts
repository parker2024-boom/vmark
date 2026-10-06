/**
 * Purpose: The step form's scalar fields — name, run, working-directory and
 *   if — as local text state committed on blur, plus the expand editor that
 *   edits `run`/`if` in a larger surface.
 *
 * Key decisions:
 *   - A field compares itself against the PRE-EDIT baseline, not the preview
 *     step: the preview already carries the field's queued edit, so comparing
 *     against it cancelled the edit just committed.
 *   - Returning a field to its baseline value cancels its queued patch rather
 *     than queueing a no-op.
 *   - Saving the expand editor commits by the same rule as a blur.
 *
 * @coordinates-with src/components/Editor/WorkflowEditor/StepForm.tsx — the consumer
 * @coordinates-with src/stores/workflowStore.ts — IRPatch sink
 * @module components/Editor/WorkflowEditor/useStepFields
 */
import { useState } from "react";
import type { StepIR } from "@/lib/ghaWorkflow/types";
import { useWorkflowStore } from "@/stores/workflowStore";

export type ExpandTarget = null | { field: "if" | "run"; value: string };

interface StepFieldsInput {
  jobId: string;
  stepIndex: number;
  step: StepIR;
  baseline: StepIR;
}

export function useStepFields({ jobId, stepIndex, step, baseline }: StepFieldsInput) {
  const [name, setName] = useState(step.name ?? "");
  const [run, setRun] = useState(step.run ?? "");
  const [workingDir, setWorkingDir] = useState(step.workingDirectory ?? "");
  const [ifCond, setIfCond] = useState(step.if ?? "");
  const [expand, setExpand] = useState<ExpandTarget>(null);

  const queue = useWorkflowStore((s) => s.queuePatch);
  const cancel = useWorkflowStore((s) => s.cancelPatchForTarget);

  const commitField = (path: string, next: string, original: string): void => {
    if (next === original) {
      // Back at the pre-edit IR value: drop any queued patch for this target.
      cancel({ kind: "step.set", jobId, stepIndex, path, value: "" });
      return;
    }
    queue({ kind: "step.set", jobId, stepIndex, path, value: next });
  };

  const handleExpandSave = (value: string): void => {
    if (!expand) return;
    const field = expand.field;
    if (field === "if") setIfCond(value);
    else setRun(value);
    const was = field === "if" ? baseline.if : baseline.run;
    commitField(field, value, was ?? "");
    setExpand(null);
  };

  return {
    name,
    setName,
    run,
    setRun,
    workingDir,
    setWorkingDir,
    ifCond,
    setIfCond,
    expand,
    setExpand,
    commitField,
    handleExpandSave,
  };
}
