/**
 * useOutlineSync — where an outline click actually scrolls (#1458).
 *
 * The heading must be measured against the editor's scroll container and
 * handed to settledScroll, which lands it on large documents where
 * content-visibility moves it mid-scroll. Real-engine proof of the settling is
 * utils/settledScroll.webkit.test.ts; this pins the hook's side of it.
 *
 * WI-RA14A.2 — the hook's editor-poll and cursor-debounce timers run on a fake
 * clock, so neither can fire at a moment the test did not choose.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listen: vi.fn((_event: string, _cb: (e: { payload: { headingIndex: number } }) => void) =>
    Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/services/editor/tiptapView", () => ({ getTiptapEditorDom: () => null }));
vi.mock("@tiptap/pm/state", () => ({ Selection: { near: (pos: unknown) => ({ anchor: pos }) } }));

import { useOutlineSync } from "./useOutlineSync";
import { scrollBehavior } from "@/utils/motion";

function rectAt(top: number): DOMRect {
  return { top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) };
}

/** An editor whose heading sits `headingTop` px down a scroller at `scrollerTop`. */
function mountEditor(scrollerTop: number, headingTop: number) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  scroller.scrollTop = 0;
  scroller.scrollTo = vi.fn();
  scroller.getBoundingClientRect = () => rectAt(scrollerTop);
  const pm = document.createElement("div");
  const heading = document.createElement("h2");
  heading.getBoundingClientRect = () => rectAt(headingTop);
  pm.appendChild(heading);
  scroller.appendChild(pm);
  document.body.appendChild(scroller);

  const view = {
    dom: pm,
    state: {
      doc: {
        descendants: (cb: (node: { type: { name: string } }, pos: number) => boolean) => {
          cb({ type: { name: "heading" } }, 7);
        },
        resolve: (pos: number) => pos,
      },
      tr: { setSelection: vi.fn().mockReturnThis(), setMeta: vi.fn().mockReturnThis() },
      selection: { anchor: 0 },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
    nodeDOM: vi.fn(() => heading),
  };
  return { scroller, view };
}

async function clickOutlineItem(headingIndex: number) {
  await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
  const call = mocks.listen.mock.calls.find((c) => c[0] === "outline:scroll-to-heading");
  call![1]({ payload: { headingIndex } });
}

describe("useOutlineSync — scroll on outline click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("scrolls the editor's scroll container so the heading reaches its top", async () => {
    const { scroller, view } = mountEditor(100, 900);
    renderHook(() => useOutlineSync(() => view as never));

    await clickOutlineItem(0);

    expect(view.dispatch).toHaveBeenCalled();
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: scrollBehavior() });
  });

  it("does not scroll for a heading index past the end of the document", async () => {
    const { scroller, view } = mountEditor(100, 900);
    renderHook(() => useOutlineSync(() => view as never));

    await clickOutlineItem(5);

    expect(view.dispatch).not.toHaveBeenCalled();
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});
