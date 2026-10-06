// WI-RA8.2 — an SVG's own <style> can style that SVG and nothing else, in a
// real engine.
/**
 * Containment is a claim about the cascade, so it is checked where the
 * cascade runs: the sanitized SVG is mounted into the page exactly as a
 * preview mounts it (innerHTML into a container), next to elements that
 * stand in for the app, and computed styles are read on both sides.
 */
import { describe, it, expect, afterEach } from "vitest";
import "@/styles/index.css";
// The stylesheets of every surface that mounts sanitized SVG, so the overlay
// test below runs against the real container rules.
import "@/plugins/codePreview/code-preview.css";
import "@/plugins/mermaid/mermaid.css";
import "@/plugins/mermaidPreview/mermaid-preview.css";
import "@/lib/formats/adapters/svg-preview.css";
import "@/lib/formats/adapters/mermaid-preview.css";
import { sanitizeSvg } from "@/utils/svgSanitize";
import { renderMermaid } from "@/plugins/mermaid";

const mounted: HTMLElement[] = [];

/** An app element, a preview holding the sanitized SVG, and the app element after it. */
function mount(svg: string) {
  const app = document.createElement("div");
  app.className = "app-chrome outside";
  app.textContent = "app";
  const preview = document.createElement("div");
  preview.className = "code-block-preview mermaid-preview";
  preview.innerHTML = sanitizeSvg(svg);
  const after = document.createElement("p");
  after.className = "after";
  after.textContent = "after";
  document.body.append(app, preview, after);
  mounted.push(app, preview, after);
  return { app, preview, after };
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  document.documentElement.style.removeProperty("--ra82-token");
  document.getElementById("ra82-app-sheet")?.remove();
});

const css = (el: Element) => getComputedStyle(el);

describe("an SVG <style> in a preview, real engine", () => {
  it("cannot hide or restyle anything outside the preview", () => {
    const { app, after } = mount(
      "<svg><style>" +
        "body *{visibility:hidden} :root{background:red} body{display:none}" +
        " .outside{display:none} p{color:rgb(255,0,0)} *{outline:9px solid red}" +
        '</style><rect class="inside" width="10" height="10"/></svg>',
    );
    expect(css(app).visibility).toBe("visible");
    expect(css(app).display).toBe("block");
    expect(css(after).color).not.toBe("rgb(255, 0, 0)");
    expect(css(document.body).display).not.toBe("none");
    expect(css(app).outlineWidth).not.toBe("9px");
  });

  it("still styles the SVG it came with — contained, not deleted", () => {
    const { preview } = mount(
      '<svg><style>body *{visibility:hidden} .inside{fill:rgb(1, 2, 3)}</style><rect class="inside" width="10" height="10"/></svg>',
    );
    const rect = preview.querySelector(".inside")!;
    expect(css(rect).fill).toBe("rgb(1, 2, 3)");
    expect(css(rect).visibility).toBe("hidden");
  });

  it("cannot reach a sibling or an ancestor through a combinator or :has()", () => {
    const { app, after } = mount(
      "<svg><style>" +
        "svg ~ *{display:none} svg + p{display:none} .app-chrome ~ *{display:none}" +
        " :root:has(svg) .outside{display:none} body:has(svg) p{display:none}" +
        "</style><rect/></svg>",
    );
    expect(css(after).display).toBe("block");
    expect(css(app).display).toBe("block");
  });

  it("cannot pin an overlay to the viewport", () => {
    const { preview } = mount(
      "<svg width=\"20\" height=\"20\"><style>.o{position:fixed;top:0;left:0;width:100vw;height:100vh}</style>" +
        '<foreignObject width="20" height="20"><div class="o">x</div></foreignObject></svg>',
    );
    const overlay = preview.querySelector(".o")!;
    expect(css(overlay).position).not.toBe("fixed");
  });

  it("sees the app's theme tokens inside", () => {
    document.documentElement.style.setProperty("--ra82-token", "rgb(10, 20, 30)");
    const { preview } = mount(
      '<svg><style>.inside{fill:var(--ra82-token)}</style><rect class="inside" width="10" height="10"/></svg>',
    );
    expect(css(preview.querySelector(".inside")!).fill).toBe("rgb(10, 20, 30)");
  });

  it("cannot redefine one of the app's keyframes, and still animates with its own", () => {
    const sheet = document.createElement("style");
    sheet.id = "ra82-app-sheet";
    sheet.textContent =
      "@keyframes ra82-app-anim{from{opacity:0.25}to{opacity:0.25}}" +
      ".app-chrome{animation:ra82-app-anim 100s linear paused}";
    document.head.append(sheet);
    const { app, preview } = mount(
      "<svg><style>@keyframes ra82-app-anim{from{opacity:0.75}to{opacity:0.75}}" +
        ".inside{animation:ra82-app-anim 100s linear paused}</style>" +
        '<rect class="inside" width="10" height="10"/></svg>',
    );
    expect(css(app).opacity).toBe("0.25");
    expect(css(preview.querySelector(".inside")!).opacity).toBe("0.75");
  });

  it("keeps a real Mermaid diagram's own styling and animated edges", async () => {
    const source =
      'flowchart LR\n  A["Start"] e1@--> B["End"]\n  e1@{ animate: true }\n  classDef hot fill:#ff0000\n  class B hot';
    const svg = await renderMermaid(source, "ra82-mermaid");
    expect(svg).not.toBeNull();
    const { preview } = mount(svg!);
    const root = preview.querySelector("svg")!;
    // Mermaid's root rule (#id{font-size:…}) reaches the root itself.
    expect(css(root).fontSize).not.toBe(css(preview).fontSize);
    // classDef styling reaches the node.
    const hot = preview.querySelector(".hot rect, .hot polygon, .hot path")!;
    expect(css(hot).fill).toBe("rgb(255, 0, 0)");
    // The animated edge resolves its (renamed) keyframes and runs.
    const edge = preview.querySelector(".edge-animation-fast, .edge-animation-slow")!;
    expect(edge.getAnimations().length).toBe(1);
  });
});

/**
 * WebKit hit-tests an absolutely positioned element inside a `foreignObject`
 * against the whole window unless the preview container is itself a
 * containing block — measured: with a plain container, every point of the
 * viewport hit the overlay, `overflow: hidden` included. `position: absolute`
 * cannot simply be filtered out (the workflow snapshot's nodes use it), so the
 * containers carry the containment.
 */
describe("an absolutely positioned overlay in a diagram, real engine", () => {
  const OVERLAY_SVG =
    '<svg width="20" height="20"><foreignObject x="0" y="0" width="20" height="20">' +
    '<div class="ra82-overlay" style="position:absolute;top:-500px;left:-500px;width:3000px;height:3000px">x</div>' +
    "</foreignObject></svg>";

  it.each([
    ["the in-editor preview", "code-block-preview mermaid-preview"],
    ["the in-editor edit-mode preview", "code-block-live-preview mermaid-live-preview"],
    ["the Source-mode popup", "mermaid-preview-content"],
    ["the standalone .svg preview", "svg-preview"],
    ["the standalone .mmd preview", "mermaid-preview"],
  ])("cannot capture clicks outside %s", (_label, className) => {
    const preview = document.createElement("div");
    preview.className = className;
    preview.style.margin = "200px";
    preview.innerHTML = sanitizeSvg(OVERLAY_SVG);
    document.body.append(preview);
    mounted.push(preview);
    const overlay = preview.querySelector(".ra82-overlay");
    expect(overlay).not.toBeNull();
    const box = preview.getBoundingClientRect();
    for (const [x, y] of [
      [5, 5],
      [box.left - 20, box.top + 5],
      [box.right + 20, box.bottom + 20],
    ]) {
      expect(document.elementFromPoint(x, y), `(${x}, ${y})`).not.toBe(overlay);
    }
  });
});
