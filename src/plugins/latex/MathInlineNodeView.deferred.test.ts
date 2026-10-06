/**
 * MathInlineNodeView — deferred rendering.
 *
 * Inside a scrolling editor (`.editor-content`) KaTeX runs only once the
 * formula's block nears the viewport; outside one (the export surface) it
 * renders on idle as it always did. See plugins/shared/nearViewport.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

const { render } = vi.hoisted(() => ({
  render: vi.fn((latex: string, el: HTMLElement) => {
    el.textContent = "";
    const out = document.createElement("span");
    out.className = "katex";
    out.textContent = latex;
    el.appendChild(out);
  }),
}));

/** `loaded: false` models the first math document of a session (KaTeX not imported yet);
 *  `gate` holds its chunk load open until the test releases it. */
const katexState = vi.hoisted(() => ({ loaded: true, loads: 0, gate: null as Promise<void> | null }));

vi.mock("@/plugins/shared/katexLoader", () => {
  const katex = { default: { render } };
  return {
    loadKatex: vi.fn(() => {
      katexState.loads++;
      const finish = () => {
        katexState.loaded = true;
        return katex;
      };
      return katexState.gate ? katexState.gate.then(finish) : Promise.resolve(finish());
    }),
    isKatexLoaded: vi.fn(() => katexState.loaded),
    getKatexModule: vi.fn(() => (katexState.loaded ? katex : null)),
  };
});
vi.mock("@/plugins/mathPreview/MathPreviewView", () => ({
  getMathPreviewView: () => ({ show: vi.fn(), hide: vi.fn(), updateContent: vi.fn() }),
}));
vi.mock("@/plugins/inlineNodeEditing/tiptap", () => ({
  inlineNodeEditingKey: { getState: vi.fn(() => null) },
}));
vi.mock("@/utils/debug", () => ({ renderWarn: vi.fn() }));

import { MathInlineNodeView } from "./MathInlineNodeView";
import { clearInlineMathRenderCache } from "./inlineMathRenderCache";
import { flushNearViewport, resetNearViewportForTest } from "@/plugins/shared/nearViewport";
import { installFakeIntersectionObserver, onlyObserver } from "@/test/fakeIntersectionObserver";
import { installFakeAnimationFrames, type FakeAnimationFrames } from "@/test/fakeAnimationFrames";

const registry = { startEditing: vi.fn(), stopEditing: vi.fn(), isEditingAt: () => false, clear: vi.fn() };

function mathNode(content: string): PMNode {
  return { type: { name: "math_inline" }, attrs: { content } } as unknown as PMNode;
}

/** A view whose DOM sits in `.editor-content`, like the WYSIWYG editor's. */
function scrollingEditor() {
  const root = document.createElement("div");
  root.className = "editor-content";
  const pm = document.createElement("div");
  pm.className = "ProseMirror";
  root.appendChild(pm);
  document.body.appendChild(root);
  const view = { dom: pm } as unknown as EditorView;
  const mount = (content: string) => {
    const nodeView = new MathInlineNodeView(mathNode(content), view, () => 0, registry);
    const p = document.createElement("p");
    p.appendChild(nodeView.dom);
    pm.appendChild(p);
    return nodeView;
  };
  return { root, mount };
}

let frames: FakeAnimationFrames;
const runFrame = () => frames.runFrame();

beforeEach(() => {
  katexState.loaded = true;
  katexState.loads = 0;
  katexState.gate = null;
  render.mockClear();
  clearInlineMathRenderCache();
  resetNearViewportForTest();
  document.body.innerHTML = "";
  frames = installFakeAnimationFrames();
  installFakeIntersectionObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MathInlineNodeView — inside a scrolling editor", () => {
  it("holds the source text until the formula's block nears the viewport", async () => {
    const { mount } = scrollingEditor();
    const view = mount("x^2");
    await Promise.resolve();

    expect(render).not.toHaveBeenCalled();
    expect(view.dom.textContent).toBe("x^2");

    onlyObserver().trigger();
    runFrame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelector(".katex")?.textContent).toBe("x^2");
  });

  it("waits with static source text, never the animated loading indicator", async () => {
    // Thousands of formulas wait off screen; an infinite CSS animation on each
    // of them was measured at over a second per scrolled frame in the app.
    katexState.loaded = false;
    const { mount } = scrollingEditor();
    const view = mount("x^2");
    await Promise.resolve();

    expect(view.dom.querySelector(".math-inline-loading")).toBeNull();
    expect(view.dom.textContent).toBe("x^2");
  });

  it("starts loading KaTeX as soon as a formula waits, not when it comes near", async () => {
    katexState.loaded = false;
    const { mount } = scrollingEditor();
    mount("x^2");
    await Promise.resolve();

    expect(katexState.loads).toBe(1);
    expect(render).not.toHaveBeenCalled();
  });

  it("renders a repeated formula through the cache, not KaTeX", async () => {
    const { mount } = scrollingEditor();
    const a = mount("0");
    const b = mount("0");
    await Promise.resolve();

    onlyObserver().trigger();
    runFrame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(a.dom.querySelector(".katex")).not.toBeNull();
    expect(b.dom.querySelector(".katex")).not.toBeNull();
  });

  it("never renders a formula destroyed while it waited", async () => {
    const { mount } = scrollingEditor();
    const view = mount("y");
    await Promise.resolve();

    view.destroy();
    expect(onlyObserver().observed.size).toBe(0);
    runFrame();
    expect(render).not.toHaveBeenCalled();
  });

  it("renders every waiting formula when the editor is flushed for print", async () => {
    const { root, mount } = scrollingEditor();
    const view = mount("\\frac{a}{b}");
    await Promise.resolve();

    await flushNearViewport(root);
    expect(view.dom.querySelector(".katex")?.textContent).toBe("\\frac{a}{b}");
  });

  it("paints formulas that waited for KaTeX's chunk inside a frame, not in one burst", async () => {
    // The first math document of a session: formulas come due while KaTeX is
    // still loading. Painting them all in the load's microtask skipped the
    // frame budget.
    katexState.loaded = false;
    let release!: () => void;
    katexState.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { mount } = scrollingEditor();
    const views = [mount("a"), mount("b"), mount("c")];
    await Promise.resolve();
    onlyObserver().trigger();
    runFrame(); // due, but KaTeX is still loading

    release();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(render).not.toHaveBeenCalled();

    onlyObserver().trigger(); // back in the queue now that KaTeX is ready
    runFrame();
    expect(views.every((view) => view.dom.querySelector(".katex") !== null)).toBe(true);
  });

  it("still renders, for print, a formula whose KaTeX was loading", async () => {
    katexState.loaded = false;
    let release!: () => void;
    katexState.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { root, mount } = scrollingEditor();
    const view = mount("\\sqrt{2}");
    await Promise.resolve();

    const flushing = flushNearViewport(root);
    release();
    await flushing;

    expect(view.dom.querySelector(".katex")?.textContent).toBe("\\sqrt{2}");
  });

  it("replaces a finished render at once, never flashing the new source", async () => {
    // A formula that already shows KaTeX output is on the reader's screen or
    // was: waiting for the observer would paint its raw LaTeX for a frame
    // first — after every edit, and every time the caret passes through it.
    const { mount } = scrollingEditor();
    const view = mount("x^2");
    await Promise.resolve();
    onlyObserver().trigger();
    runFrame();
    expect(view.dom.querySelector(".katex")?.textContent).toBe("x^2");

    view.update(mathNode("y^2"));

    expect(view.dom.querySelector(".katex")?.textContent).toBe("y^2");
    expect(frames.pending()).toBe(0);
  });

  it("still defers a formula whose preview holds no finished render", async () => {
    const { mount } = scrollingEditor();
    const view = mount("x^2");
    await Promise.resolve();

    view.update(mathNode("y^2"));
    await Promise.resolve();

    expect(render).not.toHaveBeenCalled();
    expect(view.dom.textContent).toBe("y^2");
  });
});

describe("MathInlineNodeView — without a scroll container", () => {
  it("renders on idle, as the export surface needs", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const view = new MathInlineNodeView(mathNode("z"), { dom: document.createElement("div") } as unknown as EditorView, () => 0, registry);

    vi.runAllTimers();
    expect(render).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelector(".katex")?.textContent).toBe("z");
  });
});

describe("MathInlineNodeView — update()", () => {
  function idleView(content: string) {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const view = new MathInlineNodeView(mathNode(content), { dom: document.createElement("div") } as unknown as EditorView, () => 0, registry);
    vi.runAllTimers();
    return view;
  }

  it("does not re-render for the same source (a decoration-only update)", () => {
    const view = idleView("a+b");
    const rendered = view.dom.querySelector(".katex");
    render.mockClear();

    expect(view.update(mathNode("a+b"))).toBe(true);
    vi.runAllTimers();

    expect(render).not.toHaveBeenCalled();
    expect(view.dom.querySelector(".katex")).toBe(rendered);
  });

  it("re-renders when the source changed", () => {
    const view = idleView("a+b");
    render.mockClear();

    view.update(mathNode("a-b"));
    vi.runAllTimers();

    expect(render).toHaveBeenCalledWith("a-b", expect.any(HTMLElement), expect.anything());
    expect(view.dom.getAttribute("aria-label")).toBe("Math: a-b");
  });
});
