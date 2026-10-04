/** Standalone .mmd styles must not collapse Markdown's diagram previews. */
import { afterEach, describe, expect, it } from "vitest";
import "@/styles/index.css";
import "@/plugins/codePreview/code-preview.css";
import "@/lib/formats/adapters/mermaid-preview.css";
import { renderMermaid } from "./plugin";
import { setupMermaidPanZoom } from "./mermaidPanZoom";
import { cleanupDescendants } from "@/plugins/shared/diagramCleanup";
import { sanitizeSvg } from "@/utils/sanitize";

const mounted: HTMLElement[] = [];
const frame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

afterEach(() => {
  for (const host of mounted.splice(0)) {
    cleanupDescendants(host);
    host.remove();
  }
});

function mount(markup: string, className: string) {
  const host = document.createElement("div");
  host.style.width = "640px";
  const preview = document.createElement("div");
  preview.className = className;
  preview.innerHTML = sanitizeSvg(markup);
  host.append(preview);
  document.body.append(host);
  mounted.push(host);
  return { host, preview, svg: preview.querySelector("svg")! };
}

function expectVisible(svg: SVGSVGElement, host: HTMLElement) {
  const bounds = svg.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(20);
  expect(bounds.height).toBeGreaterThan(10);
  expect(bounds.width).toBeLessThanOrEqual(host.getBoundingClientRect().width);
}

describe("Mermaid preview sizing with both stylesheets loaded", () => {
  it.each([
    ["flowchart", "flowchart LR\n A[Task] --> B[Inspect] --> C[Decide] --> D[Test] --> E[Deliver]"],
    ["cycle", "flowchart LR\n A[Evidence] --> B[Decide] --> C[Test]\n C -->|Retry| A\n C -->|Pass| D[Deliver]"],
    ["sequence", "sequenceDiagram\n participant C as Client\n participant M as MCP\n participant T as API\n C->>M: Evidence\n M->>T: Questions\n T-->>M: Judgment\n M-->>C: Result"],
  ])("keeps %s visible when leaving edit mode and resizing", async (_name, source) => {
    const markup = await renderMermaid(source);
    expect(markup).not.toBeNull();
    const { host, preview, svg } = mount(markup!, "code-block-live-preview mermaid-live-preview");
    await frame();
    expectVisible(svg, host);

    preview.className = "code-block-preview mermaid-preview";
    await frame();
    expectVisible(svg, host);
    // A short inline diagram must not inherit the standalone pane's 100% height.
    host.style.height = "900px";
    expect(preview.getBoundingClientRect().height).toBeLessThan(900);

    setupMermaidPanZoom(preview);
    await frame();
    expectVisible(svg, host);
    host.style.width = "320px";
    await frame();
    expectVisible(svg, host);
  });

  it("still fills the standalone preview pane", async () => {
    const { host, preview, svg } = mount(
      '<svg width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>',
      "mermaid-preview",
    );
    host.style.height = "400px";
    preview.style.boxSizing = "border-box";
    await frame();
    expect(preview.getBoundingClientRect().height).toBe(400);
    expectVisible(svg, host);
    expect(getComputedStyle(preview).contain).toBe("paint");
  });

  it("preserves standalone empty and invalid states", () => {
    const { preview } = mount("", "mermaid-preview mermaid-preview--empty");
    expect(getComputedStyle(preview).display).toBe("block");
    preview.className = "mermaid-preview mermaid-preview--invalid";
    expect(getComputedStyle(preview).alignItems).toBe("flex-start");
  });
});
