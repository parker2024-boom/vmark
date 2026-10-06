// WI-RA8.5 — in a real engine, converting clipboard HTML loads nothing and
// runs nothing.
// WI-RA18.5 — nor does the preview sanitizer's style filter, which re-parses
// DOMPurify's output.
/**
 * jsdom never loads an image, so only a real engine can show the effect: an
 * `<img>` the parser creates in the PAGE's document starts loading at once,
 * attached or not, and its `onerror` runs. The first test below is the
 * control — it proves this engine behaves that way, so the second test's
 * silence means something.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { htmlToMarkdown } from "./htmlToMarkdown";
import { sanitizeHtmlPreview } from "./sanitize";

declare global {
  interface Window {
    __ra85Loads?: string[];
  }
}

/** An image that cannot load, and reports the attempt by name. */
const probe = (name: string) =>
  `<img src="about:ra85-${name}" onerror="(window.__ra85Loads = window.__ra85Loads || []).push('${name}')">`;

/** Resolve once an image created after every earlier one has failed to load. */
function laterImageSettled(): Promise<void> {
  return new Promise((resolve) => {
    const control = new Image();
    control.onerror = () => resolve();
    control.src = "about:ra85-control";
  });
}

/**
 * Wait, with a bound, for something that should happen. A control's positive
 * result is waited for directly: the settle helpers only bound a load that
 * should never happen, since the engine can finish a later request first.
 */
async function eventually(happened: () => boolean): Promise<boolean> {
  const began = performance.now();
  while (!happened() && performance.now() - began < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return happened();
}

beforeEach(() => {
  window.__ra85Loads = [];
});

describe("clipboard HTML and the network, real engine", () => {
  it("control: markup parsed into the page's own document does load", async () => {
    const detached = document.createElement("div");
    detached.innerHTML = probe("page");
    expect(await eventually(() => (window.__ra85Loads ?? []).length > 0)).toBe(true);
    expect(window.__ra85Loads).toEqual(["page"]);
  });

  it("htmlToMarkdown loads nothing and runs no handler", async () => {
    const markdown = htmlToMarkdown(
      `<p>before ${probe("plain")}</p><b>bold ${probe("bold")}</b><i>italic ${probe("italic")}</i>`,
    );
    await laterImageSettled();
    expect(window.__ra85Loads).toEqual([]);
    // The images are still converted — they were parsed, just not loaded.
    expect(markdown).toContain("![](about:ra85-plain)");
    expect(markdown).toContain("![](about:ra85-bold)");
  });
});

// DOMPurify strips `onerror`, so a sanitized image cannot report its own load.
// The engine's Resource Timing record does: every fetch of a same-origin URL,
// failed or not, leaves an entry under that URL.
let probeCount = 0;
const probeUrl = (name: string): string =>
  new URL(`/ra18-probe-${name}-${(probeCount += 1)}.png`, location.href).href;
const fetched = (url: string): boolean => performance.getEntriesByName(url).length > 0;

/** Resolve once an image requested after every earlier one has finished. */
function laterFetchSettled(): Promise<void> {
  return new Promise((resolve) => {
    const control = new Image();
    control.onload = () => resolve();
    control.onerror = () => resolve();
    control.src = probeUrl("settle");
  });
}

describe("the preview sanitizer and the network, real engine", () => {
  it("control: a page-document parse of the same markup fetches the image", async () => {
    const url = probeUrl("page");
    const detached = document.createElement("div");
    detached.innerHTML = `<span style="color: red">x</span><img src="${url}">`;
    expect(await eventually(() => fetched(url))).toBe(true);
  });

  it("sanitizeHtmlPreview with styles fetches nothing", async () => {
    const url = probeUrl("preview");
    const html = sanitizeHtmlPreview(`<span style="color: red; position: fixed">x</span><img src="${url}">`, {
      allowStyles: true,
    });
    await laterFetchSettled();
    expect(fetched(url)).toBe(false);
    // The image was kept and the styles filtered — parsed, just not loaded.
    expect(html).toContain(`src="${url}"`);
    expect(html).toContain('style="color: red"');
  });
});
