// Tests for the spellcheck-threshold helpers: the mount-time attribute must
// flip when a document crosses SPELLCHECK_DISABLE_CHAR_THRESHOLD mid-session
// (the original editorProps value is computed once and never re-evaluated).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  applySpellcheckForDocSize,
  buildTiptapEditorProps,
  CV_IDLE_CHAR_THRESHOLD,
  SPELLCHECK_DISABLE_CHAR_THRESHOLD,
  spellcheckAttrForDocSize,
  suppressCvIdleDuringEdit,
  usesContentVisibility,
} from "./tiptapEditorHelpers";

/** `navigator.platform` for this test; setup pins macOS (src/test/platformDefault.ts). */
function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true, writable: true });
}

describe("buildTiptapEditorProps", () => {
  it("snapshots the spellcheck attribute from the doc size", () => {
    const small = buildTiptapEditorProps(10).attributes as Record<string, string>;
    const large = buildTiptapEditorProps(
      SPELLCHECK_DISABLE_CHAR_THRESHOLD + 1,
    ).attributes as Record<string, string>;
    expect(small.spellcheck).toBe("true");
    expect(large.spellcheck).toBe("false");
    expect(small.class).toBe("ProseMirror");
  });

  it("wires the table-aware scroll handler", () => {
    expect(typeof buildTiptapEditorProps(0).handleScrollToSelection).toBe("function");
  });
});

describe("spellcheckAttrForDocSize", () => {
  it.each([
    { docSize: 0, expected: "true" },
    { docSize: SPELLCHECK_DISABLE_CHAR_THRESHOLD, expected: "true" },
    { docSize: SPELLCHECK_DISABLE_CHAR_THRESHOLD + 1, expected: "false" },
    { docSize: 1_000_000, expected: "false" },
  ])("docSize=$docSize → $expected", ({ docSize, expected }) => {
    expect(spellcheckAttrForDocSize(docSize)).toBe(expected);
  });
});

describe("applySpellcheckForDocSize", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      editorProps: {
        attributes: { class: "ProseMirror", spellcheck: "true" },
      },
    });
  });

  afterEach(() => {
    editor.destroy();
  });

  it("disables spellcheck when the doc grows past the threshold", () => {
    const changed = applySpellcheckForDocSize(
      editor,
      SPELLCHECK_DISABLE_CHAR_THRESHOLD + 1,
    );
    expect(changed).toBe(true);
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("false");
  });

  it("re-enables spellcheck when the doc shrinks below the threshold", () => {
    applySpellcheckForDocSize(editor, SPELLCHECK_DISABLE_CHAR_THRESHOLD + 1);
    const changed = applySpellcheckForDocSize(editor, 10);
    expect(changed).toBe(true);
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("true");
  });

  it("is a no-op when the attribute already matches", () => {
    expect(applySpellcheckForDocSize(editor, 10)).toBe(false);
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("true");
  });

  it("preserves the other editorProps attributes when flipping", () => {
    applySpellcheckForDocSize(editor, SPELLCHECK_DISABLE_CHAR_THRESHOLD + 1);
    expect(editor.view.dom.getAttribute("class")).toContain("ProseMirror");
  });

  it("survives an editor without a mounted view", () => {
    editor.destroy();
    expect(applySpellcheckForDocSize(editor, 10)).toBe(false);
  });
});

// #1340 — suppressCvIdleDuringEdit must preserve the viewport across BOTH
// cv-idle toggles (the synchronous strip and the 500ms idle re-add), and must
// skip all measurement on the per-keystroke hot path where the class is
// already off. Rects are mocked (jsdom has no layout), keyed on the live
// class list like a real engine's geometry would be.
describe("suppressCvIdleDuringEdit", () => {
  function buildCvDom() {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const container = document.createElement("div");
    container.className = "tiptap-editor cv-idle";
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    const anchor = document.createElement("p");
    pm.appendChild(anchor);
    container.appendChild(pm);
    scroller.appendChild(container);
    document.body.appendChild(scroller);

    const writes: number[] = [];
    let scrollTop = 500;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
        writes.push(v);
      },
    });
    const scrollerRect = vi.fn(() => ({ top: 0, bottom: 800 }));
    const anchorRect = vi.fn(() =>
      container.classList.contains("cv-idle")
        ? { top: 10, bottom: 40 }
        : { top: 50, bottom: 80 },
    );
    const toDomRect = (r: { top: number; bottom: number }) =>
      ({
        ...r,
        left: 0,
        right: 0,
        width: 0,
        height: r.bottom - r.top,
        x: 0,
        y: r.top,
        toJSON: () => ({}),
      }) as DOMRect;
    scroller.getBoundingClientRect = () => toDomRect(scrollerRect());
    anchor.getBoundingClientRect = () => toDomRect(anchorRect());
    return { scroller, container, writes, scrollerRect, anchorRect };
  }

  // The optimization never engages on macOS; see usesContentVisibility.
  beforeEach(() => setPlatform("Win32"));

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    setPlatform("MacIntel");
  });

  it("strips cv-idle but never re-adds it on macOS", () => {
    setPlatform("MacIntel");
    vi.useFakeTimers();
    const { container } = buildCvDom();
    const timeoutRef = { current: null as number | null };

    suppressCvIdleDuringEdit({ current: container as HTMLDivElement }, CV_IDLE_CHAR_THRESHOLD * 4, timeoutRef);

    expect(container.classList.contains("cv-idle")).toBe(false);
    expect(timeoutRef.current).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(container.classList.contains("cv-idle")).toBe(false);
  });

  it("compensates the viewport when stripping cv-idle, and again on the idle re-add", () => {
    vi.useFakeTimers();
    const { scroller, container } = buildCvDom();
    const containerRef = { current: container as HTMLDivElement };
    const timeoutRef = { current: null as number | null };

    suppressCvIdleDuringEdit(containerRef, CV_IDLE_CHAR_THRESHOLD, timeoutRef);

    // Strip: anchor moved 10 → 50, so the scroller follows it down.
    expect(container.classList.contains("cv-idle")).toBe(false);
    expect(scroller.scrollTop).toBe(540);
    expect(timeoutRef.current).not.toBeNull();

    // Idle re-add: anchor moves back 50 → 10, and the viewport returns too.
    vi.advanceTimersByTime(500);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(container.classList.contains("cv-idle")).toBe(true);
    expect(scroller.scrollTop).toBe(500);
    expect(timeoutRef.current).toBeNull();
  });

  it("skips all measurement on the hot path when cv-idle is already off", () => {
    vi.useFakeTimers();
    const { container, writes, scrollerRect, anchorRect } = buildCvDom();
    container.classList.remove("cv-idle");
    const containerRef = { current: container as HTMLDivElement };
    const timeoutRef = { current: null as number | null };

    suppressCvIdleDuringEdit(containerRef, CV_IDLE_CHAR_THRESHOLD, timeoutRef);

    expect(scrollerRect).not.toHaveBeenCalled();
    expect(anchorRect).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    // The idle re-add is still scheduled for large docs.
    expect(timeoutRef.current).not.toBeNull();
    vi.advanceTimersByTime(500);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(container.classList.contains("cv-idle")).toBe(true);
  });

  it("does not schedule a re-add below the threshold but still compensates the strip", () => {
    vi.useFakeTimers();
    const { scroller, container } = buildCvDom();
    const containerRef = { current: container as HTMLDivElement };
    const timeoutRef = { current: null as number | null };

    suppressCvIdleDuringEdit(containerRef, CV_IDLE_CHAR_THRESHOLD - 1, timeoutRef);

    expect(container.classList.contains("cv-idle")).toBe(false);
    expect(scroller.scrollTop).toBe(540);
    expect(timeoutRef.current).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(container.classList.contains("cv-idle")).toBe(false);
  });

  it("clears a pending re-add and reschedules on the next edit", () => {
    vi.useFakeTimers();
    const { container } = buildCvDom();
    const containerRef = { current: container as HTMLDivElement };
    const timeoutRef = { current: null as number | null };

    suppressCvIdleDuringEdit(containerRef, CV_IDLE_CHAR_THRESHOLD, timeoutRef);
    const first = timeoutRef.current;
    vi.advanceTimersByTime(300);
    suppressCvIdleDuringEdit(containerRef, CV_IDLE_CHAR_THRESHOLD, timeoutRef);
    expect(timeoutRef.current).not.toBe(first);

    // 300ms after the second edit the first timer would have fired; it must not.
    vi.advanceTimersByTime(300);
    expect(container.classList.contains("cv-idle")).toBe(false);
    vi.advanceTimersByTime(200);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(container.classList.contains("cv-idle")).toBe(true);
  });

  it("re-adds class-only when the idle timer fires on a hidden editor", () => {
    // Source mode toggled within the 500ms window: display:none geometry
    // reports zero rects, so the re-add must still restore the class (the
    // optimization matters when the editor returns) without measuring a
    // compensation or writing scrollTop.
    vi.useFakeTimers();
    const { container, writes, anchorRect } = buildCvDom();
    const containerRef = { current: container as HTMLDivElement };
    const timeoutRef = { current: null as number | null };

    suppressCvIdleDuringEdit(containerRef, CV_IDLE_CHAR_THRESHOLD, timeoutRef);
    const writesAfterStrip = writes.length;

    // Hide the editor before the idle timer fires, zeroing all geometry the
    // way display:none does in a real engine.
    container.style.display = "none";
    anchorRect.mockImplementation(() => ({ top: 0, bottom: 0 }));

    vi.advanceTimersByTime(500);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(container.classList.contains("cv-idle")).toBe(true);
    expect(writes.length).toBe(writesAfterStrip);
  });

  it("does nothing when the container ref is empty", () => {
    const containerRef = { current: null };
    const timeoutRef = { current: null as number | null };
    expect(() =>
      suppressCvIdleDuringEdit(containerRef, CV_IDLE_CHAR_THRESHOLD, timeoutRef),
    ).not.toThrow();
    expect(timeoutRef.current).toBeNull();
  });
});

// `.cv-enabled` scopes the contain-intrinsic-size rule (editor.css) to editors
// that use content-visibility, and must survive every edit-time strip of
// `.cv-idle` — the re-add needs each block's remembered size (#1472).
describe("suppressCvIdleDuringEdit — the sizing marker", () => {
  const cvState = (el: HTMLElement) => ({
    enabled: el.classList.contains("cv-enabled"),
    idle: el.classList.contains("cv-idle"),
  });
  function edit(className: string, docSize: number) {
    const container = document.createElement("div");
    container.className = className;
    document.body.appendChild(container);
    const timeoutRef = { current: null as number | null };
    suppressCvIdleDuringEdit({ current: container as HTMLDivElement }, docSize, timeoutRef);
    return { container, timeoutRef };
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

  it("keeps the marker through the strip and the idle re-add", () => {
    const { container } = edit("tiptap-editor cv-enabled cv-idle", CV_IDLE_CHAR_THRESHOLD);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    vi.advanceTimersByTime(500);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
  });

  it("never lets the sizing rule lapse across the strip, even on a container that lacked the marker", () => {
    // Every class state the container passes through must carry the rule —
    // through `.cv-idle` or the marker. A MutationObserver sees each write.
    const container = document.createElement("div");
    container.className = "tiptap-editor cv-idle";
    document.body.appendChild(container);
    const observer = new MutationObserver(() => {});
    observer.observe(container, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });

    suppressCvIdleDuringEdit({ current: container as HTMLDivElement }, CV_IDLE_CHAR_THRESHOLD, { current: null });
    const states = [...observer.takeRecords().map((record) => record.oldValue ?? ""), container.className];
    observer.disconnect();

    expect(states.filter((state) => !/\bcv-(idle|enabled)\b/.test(state))).toEqual([]);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
  });

  it("marks a document that grows past the threshold at once, and re-adds cv-idle only after the idle window", () => {
    const { container, timeoutRef } = edit("tiptap-editor", CV_IDLE_CHAR_THRESHOLD);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    expect(timeoutRef.current).not.toBeNull();
    vi.advanceTimersByTime(499);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
    vi.advanceTimersByTime(1);
    // The re-add waits for a rendered frame after the window.
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
  });

  // `contain-intrinsic-size: auto` remembers a block's size only when a frame
  // renders it. A timer can fire before any frame has — right after a long load
  // task — and skipping then collapses every block to the estimate (a measured
  // 20,000 px jump on a large document in Linux WebKit).
  it("re-adds cv-idle only once a frame has rendered after the idle window", () => {
    const { container, timeoutRef } = edit("tiptap-editor", CV_IDLE_CHAR_THRESHOLD);
    vi.advanceTimersByTime(500);
    expect(cvState(container), "the window elapsed, no frame yet").toEqual({ enabled: true, idle: false });
    expect(timeoutRef.current, "the re-add is still due").not.toBeNull();
    vi.advanceTimersToNextFrame();
    expect(cvState(container), "the frame that records the sizes").toEqual({ enabled: true, idle: false });
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
    expect(timeoutRef.current).toBeNull();
  });

  it("an edit during the frame wait restarts the window instead of re-adding", () => {
    const { container, timeoutRef } = edit("tiptap-editor", CV_IDLE_CHAR_THRESHOLD);
    vi.advanceTimersByTime(500);
    suppressCvIdleDuringEdit({ current: container as HTMLDivElement }, CV_IDLE_CHAR_THRESHOLD, timeoutRef);
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container), "the stale re-add did not land").toEqual({ enabled: true, idle: false });
    vi.advanceTimersByTime(500);
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(cvState(container)).toEqual({ enabled: true, idle: true });
  });

  it("a cancel during the frame wait (the editor hidden) drops the re-add", () => {
    const { container, timeoutRef } = edit("tiptap-editor", CV_IDLE_CHAR_THRESHOLD);
    vi.advanceTimersByTime(500);
    // What useContentVisibilityMode's cancelReAdd does on hide.
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    vi.advanceTimersByTime(2000);
    expect(cvState(container)).toEqual({ enabled: true, idle: false });
  });

  it("unmarks a document that shrinks below the threshold, with nothing left to re-add", () => {
    const { container, timeoutRef } = edit("tiptap-editor cv-enabled cv-idle", CV_IDLE_CHAR_THRESHOLD - 1);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
    expect(timeoutRef.current).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
  });

  it("never marks an editor on macOS, however large the document", () => {
    setPlatform("MacIntel");
    const { container, timeoutRef } = edit("tiptap-editor", CV_IDLE_CHAR_THRESHOLD * 10);
    expect(cvState(container)).toEqual({ enabled: false, idle: false });
    expect(timeoutRef.current).toBeNull();
  });
});

describe("usesContentVisibility", () => {
  afterEach(() => setPlatform("MacIntel"));

  // macOS (WKWebView) never gets it: on a 4,042-block document every scrolled
  // frame cost ~1.2 s with it and ~20 ms without. Elsewhere it is unmeasured.
  it.each([
    ["Win32", CV_IDLE_CHAR_THRESHOLD, true],
    ["Win32", CV_IDLE_CHAR_THRESHOLD - 1, false],
    ["Linux x86_64", CV_IDLE_CHAR_THRESHOLD, true],
    ["MacIntel", CV_IDLE_CHAR_THRESHOLD * 10, false],
  ])("platform %s, %i chars → %s", (platform, size, expected) => {
    setPlatform(platform);
    expect(usesContentVisibility(size)).toBe(expected);
  });
});
