// Content-visibility outside edits: the mount classes and the hide/show
// transitions (useContentVisibilityMode), and document loads that cross the
// threshold (followContentReplacement, wired to useEditor's onTransaction).
// `.cv-enabled` scopes the sizing rule (editor.css); `.cv-idle` applies
// content-visibility itself. jsdom has no layout, so the viewport compensation
// is a class-only flip here (cvIdleViewportLock.test.ts covers it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { followContentReplacement, useContentVisibilityMode } from "./useContentVisibilityMode";
import { CV_IDLE_CHAR_THRESHOLD, suppressCvIdleDuringEdit } from "./tiptapEditorHelpers";

const LARGE = CV_IDLE_CHAR_THRESHOLD;
const SMALL = CV_IDLE_CHAR_THRESHOLD - 1;

/** `navigator.platform` for this test; setup pins macOS (src/test/platformDefault.ts). */
function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true, writable: true });
}

const cvState = (el: HTMLElement) => ({
  enabled: el.classList.contains("cv-enabled"),
  idle: el.classList.contains("cv-idle"),
});

function containerWith(className: string) {
  const container = document.createElement("div");
  container.className = className;
  document.body.appendChild(container);
  return {
    container,
    containerRef: { current: container as HTMLDivElement | null },
    cvIdleTimeoutRef: { current: null as number | null },
  };
}

interface Props {
  /** Length of the markdown in the store. */
  chars: number;
  hidden?: boolean;
}

function setup(chars: number, options: { strict?: boolean } = {}) {
  const dom = containerWith("tiptap-editor");
  const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
  const hook = renderHook(
    ({ chars: length, hidden = false }: Props) =>
      useContentVisibilityMode({
        containerRef: dom.containerRef,
        content: "a".repeat(length),
        hidden,
        cvIdleTimeoutRef: dom.cvIdleTimeoutRef,
      }),
    { initialProps: { chars }, ...(options.strict ? { wrapper: strict } : {}) },
  );
  return { ...dom, rerender: (props: Props) => hook.rerender(props) };
}

// A document of `size` characters, loaded the way setContentWithoutHistory
// loads one (preventUpdate), or typed in as an edit — as onTransaction reports
// it: the root transaction, and the editor holding the final document, which
// plugins' appended transactions may have changed (`finalSize`).
const schema = new Schema({ nodes: { doc: { content: "text*" }, text: {} } });
function replacement(size: number, { load = true, finalSize = size } = {}) {
  const tr = EditorState.create({ schema }).tr.insertText("a".repeat(size));
  return {
    editor: { state: { doc: { content: { size: finalSize } } } },
    transaction: load ? tr.setMeta("preventUpdate", true) : tr,
  };
}

beforeEach(() => {
  setPlatform("Win32");
  vi.useFakeTimers();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  setPlatform("MacIntel");
});

describe("useContentVisibilityMode", () => {
  // Mount applies both classes at once, from the markdown (the document is
  // parsed later): no block has been laid out, so no size to wait for.
  it.each([
    ["Win32", LARGE, { enabled: true, idle: true }],
    ["Win32", SMALL, { enabled: false, idle: false }],
    ["Linux x86_64", LARGE, { enabled: true, idle: true }],
    ["MacIntel", LARGE * 10, { enabled: false, idle: false }],
  ])("at mount on %s with %i chars → %o", (platform, chars, expected) => {
    setPlatform(platform);
    const { container, cvIdleTimeoutRef } = setup(chars);
    expect(cvState(container)).toEqual(expected);
    expect(cvIdleTimeoutRef.current).toBeNull();
  });

  // The serialized markdown differs from the document near the threshold, and
  // onUpdate decides from the document: after mount the markdown decides nothing.
  it("leaves an edit's decision alone when the flushed markdown lands on the other side of the threshold", () => {
    const { container, containerRef, cvIdleTimeoutRef, rerender } = setup(LARGE);
    suppressCvIdleDuringEdit(containerRef, LARGE, cvIdleTimeoutRef);
    const pending = cvIdleTimeoutRef.current;

    rerender({ chars: SMALL });
    expect(cvIdleTimeoutRef.current).toBe(pending);
    vi.advanceTimersByTime(500);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
  });

  // keepBothEditorsAlive: a hidden editor's blocks are not rendered, so a
  // re-add then would skip blocks that may never have recorded a size.
  it("cancels a pending re-add when the editor is hidden, keeping the marker", () => {
    const { container, containerRef, cvIdleTimeoutRef, rerender } = setup(LARGE);
    suppressCvIdleDuringEdit(containerRef, LARGE, cvIdleTimeoutRef);
    rerender({ chars: LARGE, hidden: true });
    expect(cvIdleTimeoutRef.current).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
  });

  it("starts a fresh idle window when a marked editor is shown with content-visibility off", () => {
    const { container, containerRef, cvIdleTimeoutRef, rerender } = setup(LARGE);
    suppressCvIdleDuringEdit(containerRef, LARGE, cvIdleTimeoutRef);
    rerender({ chars: LARGE, hidden: true });
    rerender({ chars: LARGE, hidden: false });
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    vi.advanceTimersByTime(499);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    vi.advanceTimersByTime(1);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
  });

  it.each([
    ["with content-visibility applied", LARGE, { enabled: true, idle: true }],
    ["without the optimization", SMALL, { enabled: false, idle: false }],
  ])("leaves the classes alone across a hide and show %s", (_label, chars, expected) => {
    const { container, cvIdleTimeoutRef, rerender } = setup(chars);
    rerender({ chars, hidden: true });
    rerender({ chars, hidden: false });
    expect(cvState(container)).toEqual(expected);
    expect(cvIdleTimeoutRef.current).toBeNull();
  });

  it("applies the mount classes once under StrictMode's double effects", () => {
    const { container, cvIdleTimeoutRef } = setup(LARGE, { strict: true });
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
    expect(cvIdleTimeoutRef.current).toBeNull();
  });

  it("does nothing without a container", () => {
    const cvIdleTimeoutRef = { current: 7 as number | null };
    const hook = renderHook(
      ({ hidden }: { hidden: boolean }) =>
        useContentVisibilityMode({ containerRef: { current: null }, content: "a".repeat(LARGE), hidden, cvIdleTimeoutRef }),
      { initialProps: { hidden: false } },
    );
    hook.rerender({ hidden: true });
    hook.rerender({ hidden: false });
    expect(cvIdleTimeoutRef.current).toBeNull();
  });
});

describe("followContentReplacement", () => {
  it("marks a document a load takes past the threshold at once, and applies content-visibility after the idle window", () => {
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor");
    followContentReplacement(containerRef, replacement(LARGE), cvIdleTimeoutRef);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    vi.advanceTimersByTime(500);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
  });

  it("drops both classes, and a pending re-add, when a load takes the document below the threshold", () => {
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor cv-enabled cv-idle");
    suppressCvIdleDuringEdit(containerRef, LARGE, cvIdleTimeoutRef);
    followContentReplacement(containerRef, replacement(SMALL), cvIdleTimeoutRef);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
    expect(cvIdleTimeoutRef.current).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
  });

  it("leaves a load that does not cross the threshold alone", () => {
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor cv-enabled cv-idle");
    followContentReplacement(containerRef, replacement(LARGE * 2), cvIdleTimeoutRef);
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
    expect(cvIdleTimeoutRef.current).toBeNull();
  });

  it("ignores edits, which onUpdate owns, and transactions that change no document", () => {
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor");
    followContentReplacement(containerRef, replacement(LARGE, { load: false }), cvIdleTimeoutRef);
    const unchanged = EditorState.create({ schema }).tr.setMeta("preventUpdate", true);
    followContentReplacement(containerRef, { editor: replacement(0).editor, transaction: unchanged }, cvIdleTimeoutRef);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
    expect(cvIdleTimeoutRef.current).toBeNull();
  });

  it("never marks an editor on macOS", () => {
    setPlatform("MacIntel");
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor");
    followContentReplacement(containerRef, replacement(LARGE * 10), cvIdleTimeoutRef);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
  });

  // An external change landing late in an edit's idle window replaces blocks
  // that have not rendered yet: the re-add waits a full window after the load.
  it("restarts a pending idle window, so the re-add comes a full window after the load", () => {
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor cv-enabled cv-idle");
    suppressCvIdleDuringEdit(containerRef, LARGE, cvIdleTimeoutRef);
    vi.advanceTimersByTime(400);
    followContentReplacement(containerRef, replacement(LARGE * 2), cvIdleTimeoutRef);
    vi.advanceTimersByTime(499);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    vi.advanceTimersByTime(1);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
  });

  // onTransaction reports the root transaction; plugins may have appended
  // changes to it (the footnote plugin deletes an orphaned definition).
  it("decides from the final document, after appended transactions", () => {
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor cv-enabled cv-idle");
    followContentReplacement(containerRef, replacement(LARGE, { finalSize: 5 }), cvIdleTimeoutRef);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
    expect(cvIdleTimeoutRef.current).toBeNull();
  });

  // onCreate's parse can run while the editor is hidden (keepBothEditorsAlive):
  // mark it, but leave the re-add to the moment it is shown.
  it("marks a hidden editor's load without starting a re-add", () => {
    const { container, containerRef, cvIdleTimeoutRef } = containerWith("tiptap-editor");
    followContentReplacement(containerRef, replacement(LARGE), cvIdleTimeoutRef, true);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    expect(cvIdleTimeoutRef.current).toBeNull();
  });
});
