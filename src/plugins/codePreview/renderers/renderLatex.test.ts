import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/plugins/latex", () => ({
  renderLatex: vi.fn(),
}));

vi.mock("@/utils/sanitize", () => ({
  sanitizeKatex: (html: string) => html,
}));

vi.mock("@/plugins/latex/latexErrorParser", () => ({
  parseLatexError: vi.fn(),
}));

vi.mock("@/utils/debug", () => ({
  renderWarn: vi.fn(),
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

import { renderLatex } from "@/plugins/latex";
import { parseLatexError } from "@/plugins/latex/latexErrorParser";
import { renderWarn } from "@/utils/debug";
import { updateLatexLivePreview, createLatexPreviewWidget } from "./renderLatex";

describe("updateLatexLivePreview", () => {
  beforeEach(() => {
    vi.mocked(renderLatex).mockReset();
    vi.mocked(parseLatexError).mockReset();
  });

  it("renders LaTeX content into the element on success", async () => {
    vi.mocked(renderLatex).mockResolvedValueOnce("<span>rendered math</span>");

    const element = document.createElement("div");
    const token = 1;
    updateLatexLivePreview(element, "\\frac{1}{2}", token, () => token);

    await vi.waitFor(() => {
      expect(element.innerHTML).toBe("<span>rendered math</span>");
    });
  });

  it("skips update when token is stale (success path)", async () => {
    vi.mocked(renderLatex).mockResolvedValueOnce("<span>rendered</span>");

    const element = document.createElement("div");
    let token = 1;
    updateLatexLivePreview(element, "\\frac{1}{2}", token, () => token);

    // Simulate token change before promise resolves
    token = 2;

    await vi.waitFor(() => {
      expect(renderLatex).toHaveBeenCalled();
    });

    // Element should NOT be updated because token changed
    expect(element.innerHTML).toBe("");
  });

  it("shows error message on render failure", async () => {
    const error = new Error("Invalid LaTeX");
    vi.mocked(renderLatex).mockRejectedValueOnce(error);
    vi.mocked(parseLatexError).mockReturnValueOnce({
      message: "Parse error",
      hint: "Check syntax",
    });

    const element = document.createElement("div");
    const token = 1;
    updateLatexLivePreview(element, "\\invalid", token, () => token);

    await vi.waitFor(() => {
      const errorDiv = element.querySelector(".code-block-live-preview-error");
      expect(errorDiv).not.toBeNull();
      expect(errorDiv!.textContent).toBe("Parse error: Check syntax");
    });
  });

  it("shows error without hint when hint is empty", async () => {
    vi.mocked(renderLatex).mockRejectedValueOnce(new Error("fail"));
    vi.mocked(parseLatexError).mockReturnValueOnce({
      message: "Unknown error",
      hint: "",
    });

    const element = document.createElement("div");
    const token = 1;
    updateLatexLivePreview(element, "bad", token, () => token);

    await vi.waitFor(() => {
      const errorDiv = element.querySelector(".code-block-live-preview-error");
      expect(errorDiv!.textContent).toBe("Unknown error");
    });
  });

  it("skips error update when token is stale (error path)", async () => {
    vi.mocked(renderLatex).mockRejectedValueOnce(new Error("fail"));
    vi.mocked(parseLatexError).mockReturnValueOnce({
      message: "err",
      hint: "",
    });

    const element = document.createElement("div");
    let token = 1;
    updateLatexLivePreview(element, "bad", token, () => token);

    token = 2;

    await vi.waitFor(() => {
      expect(renderLatex).toHaveBeenCalled();
    });

    // Element should NOT show error because token changed
    expect(element.querySelector(".code-block-live-preview-error")).toBeNull();
  });
});

describe("createLatexPreviewWidget", () => {
  beforeEach(() => {
    capturedFactory = null;
    vi.mocked(renderLatex).mockReset();
    vi.mocked(renderWarn).mockClear();
  });

  it("creates a widget decoration at the correct position", () => {
    const cache = new Map();
    const handleEnterEdit = vi.fn();
    const result = createLatexPreviewWidget(10, "\\frac{1}{2}", "key1", cache, handleEnterEdit);
    expect(result).toBeDefined();
  });

  it("creates placeholder element with correct class and text", () => {
    const cache = new Map();
    createLatexPreviewWidget(10, "\\frac{1}{2}", "key1", cache, vi.fn());

    expect(capturedFactory).not.toBeNull();
    const element = capturedFactory!(null);
    expect(element.className).toContain("latex-preview");
    expect(element.className).toContain("code-block-preview-placeholder");
    expect(element.textContent).toBe("Rendering math...");
  });

  it("renders LaTeX and updates element on success", async () => {
    vi.mocked(renderLatex).mockResolvedValueOnce("<span>math result</span>");

    const cache = new Map();
    createLatexPreviewWidget(10, "\\frac{1}{2}", "key1", cache, vi.fn());

    const element = capturedFactory!(null);

    await vi.waitFor(() => {
      expect(element.innerHTML).toBe("<span>math result</span>");
    });

    expect(element.className).toBe("code-block-preview latex-preview");
    expect(cache.get("key1")).toEqual({ rendered: "<span>math result</span>" });
  });

  it("reuses existing cache promise", async () => {
    const existingPromise = Promise.resolve("<span>cached</span>");
    const cache = new Map([["key1", { promise: existingPromise }]]);

    vi.mocked(renderLatex).mockResolvedValueOnce("<span>new</span>");

    createLatexPreviewWidget(10, "\\frac{1}{2}", "key1", cache, vi.fn());
    const element = capturedFactory!(null);

    await vi.waitFor(() => {
      expect(element.innerHTML).toBe("<span>cached</span>");
    });

    // renderLatex should not have been called since we reused the cache promise
    // (the mock was set but the cached promise was used)
  });

  it("shows error state on render failure", async () => {
    vi.mocked(renderLatex).mockRejectedValueOnce(new Error("KaTeX error"));

    const cache = new Map();
    createLatexPreviewWidget(10, "bad latex", "key1", cache, vi.fn());

    const element = capturedFactory!(null);

    await vi.waitFor(() => {
      expect(element.className).toContain("mermaid-error");
    });

    expect(element.innerHTML).toContain("Failed to render math");
    expect(renderWarn).toHaveBeenCalled();
    expect(cache.has("key1")).toBe(false); // cache entry deleted on error
  });

  it("logs non-Error objects in error path", async () => {
    vi.mocked(renderLatex).mockRejectedValueOnce("string error");

    const cache = new Map();
    createLatexPreviewWidget(10, "bad", "key1", cache, vi.fn());

    capturedFactory!(null);

    await vi.waitFor(() => {
      expect(renderWarn).toHaveBeenCalledWith(
        "LaTeX code block render failed:",
        "string error"
      );
    });
  });
});
