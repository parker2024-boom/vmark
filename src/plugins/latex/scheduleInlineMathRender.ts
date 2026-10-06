/**
 * Purpose: decide WHEN an inline formula's KaTeX render runs, and run it.
 *
 * Split out of MathInlineNodeView so the node view keeps its editing logic
 * and this file owns the render lifecycle: load KaTeX if needed, render
 * through the per-source cache, and report failure on the host element.
 *
 * Key decisions:
 *   - Inside a scrolling editor the render waits until the formula's block
 *     nears the viewport (plugins/shared/nearViewport.ts). A 11,150-formula
 *     document rendered everything at open: a 2.1 s freeze and 422K DOM
 *     elements.
 *   - With no scroll container — the off-screen export surface — it renders
 *     on idle exactly as before, because that surface's HTML is captured as
 *     soon as it settles.
 *   - This file also owns what the preview shows while it waits, so no
 *     placeholder is built only to be replaced. A formula waiting for the
 *     viewport shows its SOURCE TEXT, never the animated loading indicator
 *     the idle path uses before KaTeX has loaded: thousands of formulas wait
 *     off screen, and one infinite CSS animation each (10,775 measured in the
 *     app) cost over a second per scrolled frame. KaTeX starts loading as
 *     soon as anything waits, so it is ready when needed.
 *   - Synchronous once KaTeX is loaded, so a caller that budgets its time
 *     (the viewport queue's frame budget, a print flush) sees the real cost.
 *     A formula that comes due while KaTeX's chunk is still loading waits for
 *     it and then queues again: painting in the load's microtask ran every
 *     due formula at once, outside the frame budget.
 *   - A render that REPLACES a finished one (the formula was edited, or its
 *     source changed) runs at once: that formula is or was on screen, and
 *     the observer reports only after a frame has painted, so waiting for it
 *     flashed the raw LaTeX after every edit.
 *   - `isCurrent` lets the node view drop a render that a newer source has
 *     superseded.
 *
 * @coordinates-with plugins/latex/MathInlineNodeView.ts — the caller
 * @coordinates-with plugins/latex/inlineMathRenderCache.ts — the render itself
 * @coordinates-with plugins/shared/nearViewport.ts — the viewport deferral
 * @module plugins/latex/scheduleInlineMathRender
 */

import { loadKatex, getKatexModule, isKatexLoaded, type KatexModule } from "@/plugins/shared/katexLoader";
import { renderInlineMath } from "./inlineMathRenderCache";
import { whenNearViewport } from "@/plugins/shared/nearViewport";
import { editorScrollRoot } from "@/plugins/shared/editorScrollRoot";
import { renderWarn } from "@/utils/debug";
import { errorMessage } from "@/utils/errorMessage";

export interface InlineMathRenderRequest {
  /** Trimmed, non-empty LaTeX source. */
  latex: string;
  /** Receives KaTeX's output, or the source text on failure. */
  preview: HTMLElement;
  /** The node view's DOM: watched for the viewport, marked `.math-error` on failure. */
  host: HTMLElement;
  /** The editor view's DOM; its scroll container decides deferral. */
  editorDom: Element | null;
  /** False once a newer render has superseded this one. */
  isCurrent: () => boolean;
  /** The preview shows a finished render that this one replaces (an edit, a new source). */
  replacesRender: boolean;
}

/** Schedule the render. Returns a cancel for a render that has not run yet. */
export function scheduleInlineMathRender(request: InlineMathRenderRequest): () => void {
  const { latex, preview, host, editorDom, isCurrent, replacesRender } = request;

  const fail = () => {
    preview.textContent = latex;
    host.classList.add("math-error");
  };

  const paint = (katex: KatexModule) => {
    if (!isCurrent()) return;
    try {
      renderInlineMath(katex, latex, preview);
    } catch {
      fail();
    }
  };

  const loadFailed = (error: unknown) => {
    if (!isCurrent()) return;
    renderWarn("Math inline render failed:", errorMessage(error));
    fail();
  };

  const katex = getKatexModule();
  if (replacesRender && katex) {
    paint(katex);
    return () => {};
  }

  const scrollRoot = editorScrollRoot(editorDom);
  if (scrollRoot) {
    preview.textContent = latex;
    if (!katex) void loadKatex().catch(() => undefined); // failure reported at render
    let cancelled = false;
    let cancel = () => {};
    const whenNear = () => {
      cancel = whenNearViewport(host, scrollRoot, renderNear);
    };
    const renderNear = (): void | Promise<void> => {
      const loaded = getKatexModule();
      if (loaded) return paint(loaded);
      return loadKatex()
        .then(() => {
          if (!cancelled && isCurrent()) whenNear();
        })
        .catch(loadFailed);
    };
    whenNear();
    return () => {
      cancelled = true;
      cancel();
    };
  }

  const render = () => {
    const loaded = getKatexModule();
    if (loaded) return paint(loaded);
    void loadKatex().then(paint).catch(loadFailed);
  };

  if (isKatexLoaded()) {
    preview.textContent = latex;
  } else {
    const loading = document.createElement("span");
    loading.className = "math-inline-loading";
    loading.textContent = "…";
    preview.replaceChildren(loading);
  }
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(render, { timeout: 100 });
  } else {
    setTimeout(render, 0);
  }
  return () => {};
}
