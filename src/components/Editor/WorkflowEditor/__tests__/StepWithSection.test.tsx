// WI-RA19.10 — the `with:` section of the step form, extracted from StepForm
// so that file fits the size limit. These pin the section's own contract:
// when it renders at all, that rows commit typed patches, and that it stays a
// section of its parent form. StepForm.test.tsx still drives the same
// behaviour through the whole form.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StepIR } from "@/lib/ghaWorkflow/types";
import { useWorkflowStore } from "@/stores/workflowStore";
import { __resetRegistryForTests } from "@/lib/ghaWorkflow/actions/registry";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { StepWithSection } from "../StepWithSection";

const BASE = {
  id: "checkout",
  idSynthesized: false,
  name: "Checkout",
  position: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
} satisfies Partial<StepIR>;

/** A `uses:` step, optionally with `with:` keys. */
function makeStep(overrides: Partial<StepIR> = {}): StepIR {
  return { ...BASE, uses: "actions/checkout@v4", ...overrides };
}

/** A `run:` step — no `uses:` key at all. */
function makeRunStep(overrides: Partial<StepIR> = {}): StepIR {
  return { ...BASE, run: "echo hi", ...overrides };
}

function renderSection(step: StepIR) {
  return render(<StepWithSection jobId="build" stepIndex={2} step={step} baseline={step} />);
}

const patches = () => useWorkflowStore.getState().edit.pendingPatches;

beforeEach(() => {
  useWorkflowStore.getState().resetEdit();
  __resetRegistryForTests();
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("StepWithSection", () => {
  it("renders nothing for a run step with no with: keys", () => {
    const { container } = renderSection(makeRunStep());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders for a uses step even with no with: keys, offering Add input", () => {
    renderSection(makeStep());
    expect(screen.getByText("With")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add input/ })).toBeInTheDocument();
  });

  it("renders for a run step that carries with: keys", () => {
    renderSection(makeRunStep({ with: { shell: "bash" } }));
    expect(screen.getByDisplayValue("shell")).toBeInTheDocument();
    expect(screen.getByDisplayValue("bash")).toBeInTheDocument();
  });

  it("commits a changed value as a with.set patch for its own job and step", () => {
    renderSection(makeStep({ with: { "node-version": "20" } }));
    const value = screen.getByDisplayValue("20");
    fireEvent.change(value, { target: { value: "22" } });
    fireEvent.blur(value);
    expect(patches()).toEqual([
      { kind: "with.set", jobId: "build", stepIndex: 2, key: "node-version", value: "22" },
    ]);
  });

  it("removes a row as a with.remove patch", () => {
    renderSection(makeStep({ with: { cache: "pnpm" } }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(patches()).toEqual([{ kind: "with.remove", jobId: "build", stepIndex: 2, key: "cache" }]);
    expect(screen.queryByDisplayValue("cache")).toBeNull();
  });

  it("adds an empty row without queuing a patch until it has a key", () => {
    renderSection(makeStep());
    fireEvent.click(screen.getByRole("button", { name: /Add input/ }));
    expect(screen.getByPlaceholderText("key")).toBeInTheDocument();
    expect(patches()).toEqual([]);
  });

  it("flags a duplicate key inline instead of committing it", () => {
    renderSection(makeStep({ with: { a: "1", b: "2" } }));
    const keyB = screen.getByDisplayValue("b");
    fireEvent.change(keyB, { target: { value: "a" } });
    fireEvent.blur(keyB);
    expect(screen.getByRole("alert")).toHaveTextContent("Duplicate key");
    expect(patches()).toEqual([]);
  });
});
