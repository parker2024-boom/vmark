// @vitest-environment node
// WI-RA10B.7 — the signal auto-save reads to decide whether a flush is needed.
import { describe, it, expect, beforeEach } from "vitest";
import { hasPendingWysiwygEdit, setWysiwygEditPending } from "./wysiwygEditPending";

const editorA = {};
const editorB = {};

beforeEach(() => {
  setWysiwygEditPending(editorA, false);
  setWysiwygEditPending(editorB, false);
});

describe("wysiwygEditPending", () => {
  it("reports nothing pending until an editor says so", () => {
    expect(hasPendingWysiwygEdit()).toBe(false);
    setWysiwygEditPending(editorA, true);
    expect(hasPendingWysiwygEdit()).toBe(true);
  });

  it("is cleared by the editor that set it", () => {
    setWysiwygEditPending(editorA, true);
    setWysiwygEditPending(editorA, false);
    expect(hasPendingWysiwygEdit()).toBe(false);
  });

  it("keeps one editor's pending edit when another editor flushes", () => {
    setWysiwygEditPending(editorA, true);
    setWysiwygEditPending(editorB, true);
    setWysiwygEditPending(editorB, false);
    expect(hasPendingWysiwygEdit()).toBe(true);
  });

  it("is idempotent: repeated edits count once, repeated clears do nothing", () => {
    setWysiwygEditPending(editorA, true);
    setWysiwygEditPending(editorA, true);
    setWysiwygEditPending(editorA, false);
    expect(hasPendingWysiwygEdit()).toBe(false);
    setWysiwygEditPending(editorA, false);
    expect(hasPendingWysiwygEdit()).toBe(false);
  });
});
