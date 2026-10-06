// WI-RA17A.2 — step scalar fields: commit on blur against the baseline, and the expand editor
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StepIR } from "@/lib/ghaWorkflow/types";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useStepFields } from "../useStepFields";

/** A step with only the required fields; optional ones are added by the caller. */
const bareStep: StepIR = {
  id: "build-step",
  idSynthesized: false,
  position: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
};

function makeStep(overrides: Partial<StepIR> = {}): StepIR {
  return { ...bareStep, name: "Build", run: "make", if: "success()", workingDirectory: "src", ...overrides };
}

const pending = () => useWorkflowStore.getState().edit.pendingPatches;

function setup(step = makeStep(), baseline = step) {
  return renderHook(() => useStepFields({ jobId: "build", stepIndex: 0, step, baseline }));
}

beforeEach(() => {
  useWorkflowStore.getState().resetEdit();
});

describe("useStepFields", () => {
  it("starts from the step's values, empty when absent", () => {
    const { result } = setup({ ...bareStep, run: "make", if: "success()" });
    expect(result.current.name).toBe("");
    expect(result.current.run).toBe("make");
    expect(result.current.workingDir).toBe("");
    expect(result.current.ifCond).toBe("success()");
    expect(result.current.expand).toBeNull();
  });

  it("queues a step.set for a changed field", () => {
    const { result } = setup();
    act(() => result.current.commitField("name", "Compile", "Build"));
    expect(pending()).toEqual([
      { kind: "step.set", jobId: "build", stepIndex: 0, path: "name", value: "Compile" },
    ]);
  });

  it("cancels the queued patch when the field returns to its baseline", () => {
    const { result } = setup();
    act(() => result.current.commitField("name", "Compile", "Build"));
    act(() => result.current.commitField("name", "Build", "Build"));
    expect(pending()).toEqual([]);
  });

  it("saving the expand editor sets the field and commits it against the baseline", () => {
    const step = makeStep({ run: "make all" });
    const { result } = setup(step, makeStep());
    act(() => result.current.setExpand({ field: "run", value: "make all" }));
    act(() => result.current.handleExpandSave("make"));
    expect(result.current.run).toBe("make");
    expect(result.current.expand).toBeNull();
    expect(pending()).toEqual([]);

    act(() => result.current.setExpand({ field: "if", value: "success()" }));
    act(() => result.current.handleExpandSave("always()"));
    expect(result.current.ifCond).toBe("always()");
    expect(pending()).toEqual([
      { kind: "step.set", jobId: "build", stepIndex: 0, path: "if", value: "always()" },
    ]);
  });

  it("compares an absent baseline field as empty", () => {
    const { result } = setup({ ...bareStep, run: "make" });
    act(() => result.current.setExpand({ field: "if", value: "" }));
    act(() => result.current.handleExpandSave(""));
    expect(pending()).toEqual([]);
  });

  it("ignores a save with no expand editor open", () => {
    const { result } = setup();
    act(() => result.current.handleExpandSave("x"));
    expect(result.current.run).toBe("make");
    expect(pending()).toEqual([]);
  });
});
