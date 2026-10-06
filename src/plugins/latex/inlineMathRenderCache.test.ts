import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KatexModule } from "@/plugins/shared/katexLoader";
import {
  renderInlineMath,
  clearInlineMathRenderCache,
  inlineMathRenderCacheSize,
  INLINE_MATH_CACHE_LIMIT,
} from "./inlineMathRenderCache";

/** A KaTeX stand-in that renders `<span class="katex">latex</span>`, like the real one clears first. */
function fakeKatex() {
  const render = vi.fn((latex: string, el: HTMLElement) => {
    el.textContent = "";
    const out = document.createElement("span");
    out.className = "katex";
    out.textContent = latex;
    el.appendChild(out);
  });
  return { katex: { default: { render } } as unknown as KatexModule, render };
}

beforeEach(() => clearInlineMathRenderCache());

describe("renderInlineMath", () => {
  it("renders through KaTeX as inline math, replacing the target's children", () => {
    const { katex, render } = fakeKatex();
    const target = document.createElement("span");
    target.textContent = "x^2";

    renderInlineMath(katex, "x^2", target);

    expect(render).toHaveBeenCalledWith("x^2", target, { throwOnError: false, displayMode: false });
    expect(target.childNodes).toHaveLength(1);
    expect(target.querySelector(".katex")?.textContent).toBe("x^2");
  });

  it("calls KaTeX once per distinct source and clones for repeats", () => {
    const { katex, render } = fakeKatex();
    const a = document.createElement("span");
    const b = document.createElement("span");

    renderInlineMath(katex, "0", a);
    renderInlineMath(katex, "0", b);

    expect(render).toHaveBeenCalledTimes(1);
    expect(b.querySelector(".katex")?.textContent).toBe("0");
    // Never the same node in two places.
    expect(a.firstChild).not.toBe(b.firstChild);
  });

  it("does not let a later edit of rendered DOM leak into the cache", () => {
    const { katex } = fakeKatex();
    const a = document.createElement("span");
    renderInlineMath(katex, "y", a);
    a.querySelector(".katex")!.textContent = "tampered";

    const b = document.createElement("span");
    renderInlineMath(katex, "y", b);
    expect(b.textContent).toBe("y");
  });

  it("caches nothing when KaTeX produced no single root", () => {
    const render = vi.fn();
    const katex = { default: { render } } as unknown as KatexModule;
    const target = document.createElement("span");
    target.textContent = "placeholder";

    renderInlineMath(katex, "z", target);
    renderInlineMath(katex, "z", target);

    expect(render).toHaveBeenCalledTimes(2);
    expect(inlineMathRenderCacheSize()).toBe(0);
    expect(target.textContent).toBe("");
  });

  it("propagates a KaTeX exception and caches nothing", () => {
    const katex = { default: { render: () => { throw new Error("boom"); } } } as unknown as KatexModule;
    expect(() => renderInlineMath(katex, "\\bad", document.createElement("span"))).toThrow("boom");
    expect(inlineMathRenderCacheSize()).toBe(0);
  });

  it("evicts the least recently used source past the limit", () => {
    const { katex, render } = fakeKatex();
    const el = () => document.createElement("span");
    for (let i = 0; i < INLINE_MATH_CACHE_LIMIT; i++) renderInlineMath(katex, `f${i}`, el());
    // Touch f0 so f1 becomes the oldest.
    renderInlineMath(katex, "f0", el());
    renderInlineMath(katex, "overflow", el());

    expect(inlineMathRenderCacheSize()).toBe(INLINE_MATH_CACHE_LIMIT);
    render.mockClear();
    renderInlineMath(katex, "f0", el());
    expect(render).not.toHaveBeenCalled();
    renderInlineMath(katex, "f1", el());
    expect(render).toHaveBeenCalledTimes(1);
  });
});
