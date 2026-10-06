// WI-RA17A.2 — step navigation: back to job, prev/next, and Alt+Arrow outside editable surfaces
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useStepNavigation } from "../useStepNavigation";

function selection() {
  const { selectedJobId, selectedStepId } = useWorkflowStore.getState().view;
  return { selectedJobId, selectedStepId };
}

function pressAlt(key: string, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  useWorkflowStore.getState().resetView();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("useStepNavigation", () => {
  it("goToStep selects the step in its job, and ignores null", () => {
    const { result } = renderHook(() => useStepNavigation("build", null, null));
    act(() => result.current.goToStep(null));
    expect(selection()).toEqual({ selectedJobId: null, selectedStepId: null });
    act(() => result.current.goToStep("s2"));
    expect(selection()).toEqual({ selectedJobId: "build", selectedStepId: "s2" });
  });

  it("backToJob selects the job with no step", () => {
    useWorkflowStore.getState().selectStep("build", "s1");
    const { result } = renderHook(() => useStepNavigation("build", null, null));
    act(() => result.current.backToJob());
    expect(selection()).toEqual({ selectedJobId: "build", selectedStepId: null });
  });

  it("Alt+Left and Alt+Right walk to the neighbouring steps", () => {
    renderHook(() => useStepNavigation("build", "s0", "s2"));
    expect(pressAlt("ArrowLeft").defaultPrevented).toBe(true);
    expect(selection().selectedStepId).toBe("s0");
    pressAlt("ArrowRight");
    expect(selection().selectedStepId).toBe("s2");
  });

  it("does nothing at the ends, without Alt, or when already handled", () => {
    renderHook(() => useStepNavigation("build", null, null));
    expect(pressAlt("ArrowLeft").defaultPrevented).toBe(false);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); });
    expect(selection().selectedStepId).toBeNull();
  });

  it("ignores an event another handler already prevented", () => {
    renderHook(() => useStepNavigation("build", "s0", "s2"));
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true });
    event.preventDefault();
    act(() => { window.dispatchEvent(event); });
    expect(selection().selectedStepId).toBeNull();
  });

  it.each(["input", "textarea", "select"])("leaves Alt+Arrow to a focused %s", (tag) => {
    const el = document.createElement(tag);
    document.body.append(el);
    cleanups.push(() => el.remove());
    renderHook(() => useStepNavigation("build", "s0", "s2"));
    expect(pressAlt("ArrowLeft", el).defaultPrevented).toBe(false);
    expect(selection().selectedStepId).toBeNull();
  });

  it("leaves Alt+Arrow to CodeMirror and contenteditable hosts", () => {
    const cm = document.createElement("div");
    cm.className = "cm-editor";
    const inner = document.createElement("span");
    cm.append(inner);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.append(cm, editable);
    cleanups.push(() => { cm.remove(); editable.remove(); });
    renderHook(() => useStepNavigation("build", "s0", "s2"));
    pressAlt("ArrowLeft", inner);
    pressAlt("ArrowRight", editable);
    expect(selection().selectedStepId).toBeNull();
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useStepNavigation("build", "s0", "s2"));
    unmount();
    pressAlt("ArrowLeft");
    expect(selection().selectedStepId).toBeNull();
  });

  // WI-RA17F.7 — the shortcut must follow the CURRENT job. Two jobs can share
  // neighbouring step ids (both `null` at an end, or the same generated id),
  // so a job switch that leaves prev/next unchanged must still re-target.
  it("Alt+Arrow selects in the current job after the job changes but the neighbours do not", () => {
    const { rerender } = renderHook(
      ({ jobId }) => useStepNavigation(jobId, "s0", "s2"),
      { initialProps: { jobId: "build" } },
    );
    rerender({ jobId: "test" });
    pressAlt("ArrowLeft");
    expect(selection()).toEqual({ selectedJobId: "test", selectedStepId: "s0" });
  });
});
