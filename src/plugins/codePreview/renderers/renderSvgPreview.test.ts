import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/plugins/svg/svgRender", () => ({
  renderSvgBlock: vi.fn(),
}));

vi.mock("@/utils/sanitize", () => ({
  sanitizeSvg: (svg: string) => svg,
}));

// Mock Decoration.widget to capture the factory function
let capturedFactory: ((view: unknown) => HTMLElement) | null = null;
vi.mock("@tiptap/pm/view", () => ({
  Decoration: {
    widget: vi.fn((_pos: number, factory: (view: unknown) => HTMLElement, _opts?: unknown) => {
      capturedFactory = factory;
      return { type: "widget" };
    }),
  },
}));

// The real preview helpers attach pan/zoom on the next frame; the third-party
// Panzoom engine needs SVG transforms jsdom lacks, so it is the one faked.
vi.mock("@panzoom/panzoom", () => ({
  default: vi.fn(() => ({
    zoomWithWheel: vi.fn(),
    handleDown: vi.fn(),
    handleMove: vi.fn(),
    handleUp: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  })),
}));

import { renderSvgBlock } from "@/plugins/svg/svgRender";
import { updateSvgLivePreview, createSvgPreviewWidget } from "./renderSvgPreview";

describe("updateSvgLivePreview", () => {
  beforeEach(() => {
    vi.mocked(renderSvgBlock).mockReset();
  });

  it("renders valid SVG content into the element", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce("<svg><circle r='10'/></svg>");

    const element = document.createElement("div");
    const token = 1;
    updateSvgLivePreview(element, "<svg><circle r='10'/></svg>", token, () => token);

    // Browser normalizes HTML attributes — use toContain for robustness
    expect(element.innerHTML).toContain("svg");
    expect(element.innerHTML).toContain("circle");
  });

  it("shows error for invalid SVG content", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce(null);

    const element = document.createElement("div");
    const token = 1;
    updateSvgLivePreview(element, "not svg", token, () => token);

    expect(element.innerHTML).toContain("Invalid SVG");
    expect(element.innerHTML).toContain("code-block-live-preview-error");
  });

  it("skips update when token is stale", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce("<svg></svg>");

    const element = document.createElement("div");
    const token = 1;
    updateSvgLivePreview(element, "<svg></svg>", token, () => {
      // Return different token to simulate staleness
      return 2;
    });

    expect(element.innerHTML).toBe("");
  });

  it("handles empty SVG string from renderer as invalid", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce(null);

    const element = document.createElement("div");
    const token = 1;
    updateSvgLivePreview(element, "", token, () => token);

    expect(element.innerHTML).toContain("Invalid SVG");
  });
});

describe("createSvgPreviewWidget", () => {
  beforeEach(() => {
    capturedFactory = null;
    vi.mocked(renderSvgBlock).mockReset();
  });

  const dblclick = (el: HTMLElement) =>
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

  it("creates a rendered preview element for valid SVG", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce("<svg><rect/></svg>");

    const cache = new Map();
    const handleEnterEdit = vi.fn();
    createSvgPreviewWidget(10, "<svg><rect/></svg>", "key1", cache, handleEnterEdit);

    expect(capturedFactory).not.toBeNull();
    const element = capturedFactory!(null);

    // SVG output shares the diagram preview chrome.
    expect(element.className).toBe("code-block-preview mermaid-preview");
    expect(element.querySelector("svg rect")).not.toBeNull();

    // Cache should be populated
    expect(cache.get("key1")).toEqual({ rendered: "<svg><rect/></svg>" });
  });

  it("creates error widget for invalid SVG", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce(null);

    const cache = new Map();
    createSvgPreviewWidget(10, "bad svg", "key1", cache, vi.fn());

    expect(capturedFactory).not.toBeNull();
    const element = capturedFactory!(null);

    expect(element.className).toContain("mermaid-error");
    expect(element.innerHTML).toContain("Invalid SVG");
  });

  it("double-clicking the error widget enters edit mode for its view", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce(null);

    const cache = new Map();
    const handleEnterEdit = vi.fn();
    createSvgPreviewWidget(10, "bad", "key1", cache, handleEnterEdit);

    const view = { state: {} };
    const element = capturedFactory!(view);
    dblclick(element);
    expect(handleEnterEdit).toHaveBeenCalledWith(view);
  });

  it("does not cache invalid SVG", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce(null);

    const cache = new Map();
    createSvgPreviewWidget(10, "bad", "key1", cache, vi.fn());

    expect(cache.has("key1")).toBe(false);
  });

  it("double-clicking a valid preview enters edit mode for its view", () => {
    vi.mocked(renderSvgBlock).mockReturnValueOnce("<svg></svg>");

    const cache = new Map();
    const handleEnterEdit = vi.fn();
    createSvgPreviewWidget(10, "<svg></svg>", "key1", cache, handleEnterEdit);

    const view = { state: {} };
    const element = capturedFactory!(view);
    expect(handleEnterEdit).not.toHaveBeenCalled();
    dblclick(element);
    expect(handleEnterEdit).toHaveBeenCalledWith(view);
  });
});
