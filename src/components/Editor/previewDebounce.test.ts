// WI-RA10B.4 — a split-view preview waits for typing to settle before it
// re-parses a large document, on the same size tiers as the WYSIWYG flush.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { getAdaptiveDebounceDelay } from "./tiptapEditorHelpers";
import { previewSyncDelay, useSettledPreviewContent } from "./previewDebounce";

const doc = (chars: number, tail = "") => "x".repeat(chars - tail.length) + tail;

describe("previewSyncDelay", () => {
  it.each([0, 1, 5_000, 20_000])("a %i-character document is not delayed", (size) => {
    expect(previewSyncDelay(size)).toBe(0);
  });

  it.each([20_001, 50_001, 100_001, 500_001, 1_000_001])(
    "a %i-character document waits exactly as long as the WYSIWYG flush does",
    (size) => {
      expect(previewSyncDelay(size)).toBe(getAdaptiveDebounceDelay(size));
      expect(previewSyncDelay(size)).toBeGreaterThan(100);
    },
  );
});

describe("useSettledPreviewContent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = (initial: string) =>
    renderHook((content: string) => useSettledPreviewContent(content), { initialProps: initial });

  it("passes a small document straight through, every keystroke", () => {
    const { result, rerender } = settle("a");
    rerender("ab");
    expect(result.current).toBe("ab");
    rerender("");
    expect(result.current).toBe("");
  });

  it("holds a large document's previous content until typing has paused for its tier", () => {
    const first = doc(30_000, "1");
    const { result, rerender } = settle(first);
    expect(result.current).toBe(first);

    rerender(doc(30_000, "2"));
    act(() => void vi.advanceTimersByTime(299));
    expect(result.current).toBe(first);

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(doc(30_000, "2"));
  });

  it("restarts the wait on each keystroke and settles once, on the last one", () => {
    const first = doc(30_000, "1");
    const seen: string[] = [];
    const { rerender } = renderHook(
      (content: string) => {
        const settled = useSettledPreviewContent(content);
        if (seen[seen.length - 1] !== settled) seen.push(settled);
        return settled;
      },
      { initialProps: first },
    );

    for (const tail of ["2", "3", "4"]) {
      rerender(doc(30_000, tail));
      act(() => void vi.advanceTimersByTime(200));
    }
    expect(seen).toEqual([first]);

    act(() => void vi.advanceTimersByTime(300));
    expect(seen).toEqual([first, doc(30_000, "4")]);
  });

  it("uses the tier of the document's current size", () => {
    const first = doc(60_000, "1");
    const { result, rerender } = settle(first);

    rerender(doc(60_000, "2"));
    act(() => void vi.advanceTimersByTime(499));
    expect(result.current).toBe(first);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(doc(60_000, "2"));
  });

  it("a document that grows past the threshold keeps showing its last content, not an older one", () => {
    const { result, rerender } = settle(doc(19_999));
    rerender(doc(20_000));
    expect(result.current).toBe(doc(20_000));

    rerender(doc(20_001));
    expect(result.current).toBe(doc(20_000));
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current).toBe(doc(20_001));
  });

  it("a document that shrinks below the threshold is current at once", () => {
    const { result, rerender } = settle(doc(30_000));
    rerender("short");
    expect(result.current).toBe("short");
    act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current).toBe("short");
  });

  it("content that returns to the settled value cancels the wait", () => {
    const first = doc(30_000, "1");
    const { result, rerender } = settle(first);
    rerender(doc(30_000, "2"));
    rerender(first);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(first);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind on unmount", () => {
    const { rerender, unmount } = settle(doc(30_000, "1"));
    rerender(doc(30_000, "2"));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
