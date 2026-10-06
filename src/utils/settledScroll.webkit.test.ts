/**
 * Settled scroll in a real engine (#1458).
 *
 * The defect only exists with real layout: blocks under
 * `content-visibility: auto` change height as a scroll brings them near the
 * viewport, so a smooth scroll to a far heading stopped thousands of pixels
 * short (3,668px here in WebKit before the fix). jsdom cannot show that; this
 * tier can. Geometry mirrors editor.css: the same content-visibility rule on
 * the direct children of the content root, and blocks far taller than the
 * 2.5em estimate, as real paragraphs are.
 */
import { describe, it, expect, afterEach } from "vitest";
import { scrollToSettled } from "./settledScroll";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * More animation frames than scrollToSettled's correction loop can run: it
 * stops after at most MAX_FRAMES (60) frames when no render is busy, and no
 * render is busy here. Counting frames instead of milliseconds waits for the
 * loop itself, however slowly the machine paints.
 */
const CORRECTION_LOOP_BOUND_FRAMES = 64;

function buildLargeDocument() {
  const style = document.createElement("style");
  style.textContent =
    ".cv-root > * { content-visibility: auto; contain-intrinsic-size: auto 2.5em; } .cv-root p { margin: 1em 0; }";
  document.head.appendChild(style);

  const scroller = document.createElement("div");
  scroller.style.cssText = "height:400px;width:500px;overflow:auto;position:relative";
  const root = document.createElement("div");
  root.className = "cv-root";
  const paragraph = "lorem ipsum dolor sit amet consectetur ".repeat(12);
  const headings: HTMLElement[] = [];
  for (let i = 0; i < 40; i += 1) {
    const h = document.createElement("h2");
    h.textContent = `Heading ${i}`;
    headings.push(h);
    root.appendChild(h);
    for (let j = 0; j < 6; j += 1) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      root.appendChild(p);
    }
  }
  scroller.appendChild(root);
  document.body.appendChild(scroller);
  return { scroller, root, headings, cleanup: () => { scroller.remove(); style.remove(); } };
}

describe("scrollToSettled under content-visibility (real engine)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it("lands each far heading at the top of the viewport on the first try", async () => {
    const doc = buildLargeDocument();
    cleanup = doc.cleanup;
    await nextFrame();
    await nextFrame();

    const offsets: number[] = [];
    for (const index of [30, 5, 20]) {
      const target = doc.headings[index];
      const distance = () => target.getBoundingClientRect().top - doc.scroller.getBoundingClientRect().top;
      scrollToSettled(doc.scroller, distance, doc.root);
      for (let frame = 0; frame < CORRECTION_LOOP_BOUND_FRAMES; frame += 1) await nextFrame();
      offsets.push(Math.round(Math.abs(distance())));
    }

    // Within a pixel: correction stops once less than 1px remains.
    expect(Math.max(...offsets), `offsets from the top: ${offsets.join(", ")}px`).toBeLessThanOrEqual(1);
  });
});
