// WI-RA17A.2 — a step's with: rows: commit, duplicate rejection, removal, suggestions from action metadata
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { StepIR } from "@/lib/ghaWorkflow/types";
import { useWorkflowStore } from "@/stores/workflowStore";
import { __resetRegistryForTests } from "@/lib/ghaWorkflow/actions/registry";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useStepWithRows } from "../useStepWithRows";

/** A step with only the required fields; optional ones are added by the caller. */
const bareStep: StepIR = {
  id: "checkout",
  idSynthesized: false,
  position: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
};

function makeStep(overrides: Partial<StepIR> = {}): StepIR {
  return { ...bareStep, uses: "actions/checkout@v4", with: { "fetch-depth": "0" }, ...overrides };
}

const metadataOk = {
  kind: "ok",
  from_cache: false,
  metadata: {
    name: "Checkout",
    description: "",
    inputs: {
      "fetch-depth": { description: "Number of commits", required: false, default: "1" },
      token: { description: "Auth token", required: true },
    },
    outputs: {},
  },
};

const pending = () => useWorkflowStore.getState().edit.pendingPatches;

function setup(step = makeStep()) {
  return renderHook(() => useStepWithRows({ jobId: "build", stepIndex: 2, step, baseline: step }));
}

beforeEach(() => {
  useWorkflowStore.getState().resetEdit();
  __resetRegistryForTests();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ kind: "unavailable", reason: "offline" });
});

describe("useStepWithRows — rows", () => {
  it("loads rows from the step's with: block", () => {
    const { result } = setup();
    expect(result.current.withRows.map((r) => [r.key, r.value])).toEqual([["fetch-depth", "0"]]);
    expect(result.current.datalistId).toBe("workflow-form-with-keys-build-2");
  });

  it("commits an edited value as a with.set", () => {
    const { result } = setup();
    act(() => result.current.updateRow(0, { value: "1" }));
    act(() => result.current.commitWithRow(0));
    expect(pending()).toEqual([
      { kind: "with.set", jobId: "build", stepIndex: 2, key: "fetch-depth", value: "1" },
    ]);
    expect(result.current.withRows[0].committedKey).toBe("fetch-depth");
  });

  it("does nothing when a blank new row is committed", () => {
    const { result } = setup();
    act(() => result.current.addRow());
    act(() => result.current.commitWithRow(1));
    expect(pending()).toEqual([]);
  });

  it("rejects a key another row holds", () => {
    const { result } = setup();
    act(() => result.current.addRow());
    act(() => result.current.updateRow(1, { key: "fetch-depth", value: "5" }));
    act(() => result.current.commitWithRow(1));
    expect(result.current.withRows[1].duplicateKey).toBe(true);
    expect(pending()).toEqual([]);
  });

  it("removing a loaded row queues with.remove and drops the row", () => {
    const { result } = setup();
    act(() => result.current.removeRow(0));
    expect(result.current.withRows).toEqual([]);
    expect(pending()).toEqual([
      { kind: "with.remove", jobId: "build", stepIndex: 2, key: "fetch-depth" },
    ]);
  });

  it("adds a suggested key once", () => {
    const { result } = setup({ ...bareStep, uses: "actions/checkout@v4" });
    act(() => result.current.addSuggestedKey("token"));
    act(() => result.current.addSuggestedKey("token"));
    expect(result.current.withRows.map((r) => r.key)).toEqual(["token"]);
  });
});

describe("useStepWithRows — action metadata", () => {
  it("has no inputs for a run step", () => {
    const { result } = setup({ ...bareStep, run: "make" });
    expect(result.current.metadataResult.state).toBe("idle");
    expect(result.current.inputs).toBeNull();
    expect(result.current.knownInputKeys).toEqual([]);
    expect(result.current.missingRequired).toEqual([]);
  });

  it("lists known inputs and the required ones not yet set", async () => {
    invokeMock.mockResolvedValue(metadataOk);
    const { result } = setup();
    await waitFor(() => expect(result.current.metadataResult.state).toBe("success"));
    expect(result.current.knownInputKeys).toEqual(["fetch-depth", "token"]);
    expect(result.current.missingRequired.map(([key]) => key)).toEqual(["token"]);
    expect(result.current.setKeys.has("fetch-depth")).toBe(true);

    act(() => result.current.addSuggestedKey("token"));
    expect(result.current.missingRequired).toEqual([]);
  });
});
