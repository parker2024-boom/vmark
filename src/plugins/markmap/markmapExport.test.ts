/**
 * Tests for Markmap Export
 *
 * Covers the setupMarkmapExport function which renders markmap SVG,
 * converts to PNG, and saves via Tauri dialog. The real markmap renderer
 * (./plugin) runs; only the third-party markmap packages underneath it are
 * replaced, because markmap-view's D3 layout needs a real layout engine.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const mockSave = vi.fn();
const mockWriteFile = vi.fn();
const mockTransform = vi.fn();
const mockCreate = vi.fn();
const mockSvgToPngBytes = vi.fn();
const mockDiagramWarn = vi.fn();
const mockSetupDiagramExport = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock("markmap-lib", () => ({
  Transformer: class {
    transform(md: string) {
      return mockTransform(md);
    }
  },
}));

vi.mock("markmap-view", () => ({
  Markmap: { create: (...args: unknown[]) => mockCreate(...args) },
}));

vi.mock("@/utils/svgToPng", () => ({
  svgToPngBytes: (...args: unknown[]) => mockSvgToPngBytes(...args),
}));

vi.mock("@/utils/debug", () => ({
  diagramWarn: (...args: unknown[]) => mockDiagramWarn(...args),
}));

vi.mock("@/plugins/shared/diagramExport", () => ({
  setupDiagramExport: (...args: unknown[]) => mockSetupDiagramExport(...args),
  LIGHT_BG: "#ffffff",
  DARK_BG: "#1e1e1e",
}));

import { setupMarkmapExport } from "./markmapExport";

let container: HTMLElement;
let capturedDoExport: ((theme: "light" | "dark") => Promise<void>) | null;

beforeEach(() => {
  vi.clearAllMocks();
  mockTransform.mockImplementation((md: string) => ({ root: { content: md } }));
  // A stand-in Markmap that draws the root's content into the SVG it is given,
  // so the serialized export proves the real renderer mounted and serialized.
  mockCreate.mockImplementation((svg: SVGSVGElement, _opts: unknown, root: { content: string }) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = root.content;
    svg.appendChild(text);
    return { fit: vi.fn(), destroy: vi.fn(), svg: { on: vi.fn() } };
  });
  container = document.createElement("div");
  capturedDoExport = null;

  mockSetupDiagramExport.mockImplementation(
    (_container: HTMLElement, doExport: (theme: "light" | "dark") => Promise<void>) => {
      capturedDoExport = doExport;
      return { destroy: vi.fn() };
    },
  );
});

afterEach(() => {
  capturedDoExport = null;
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
describe("setupMarkmapExport", () => {
  it("calls setupDiagramExport with container and callback", () => {
    setupMarkmapExport(container, "# Hello");

    expect(mockSetupDiagramExport).toHaveBeenCalledWith(
      container,
      expect.any(Function),
    );
  });

  it("returns the ExportInstance from setupDiagramExport", () => {
    const mockDestroy = vi.fn();
    mockSetupDiagramExport.mockReturnValue({ destroy: mockDestroy });

    const instance = setupMarkmapExport(container, "# Hello");
    expect(instance.destroy).toBe(mockDestroy);
  });
});

// ---------------------------------------------------------------------------
// Export callback - light theme
// ---------------------------------------------------------------------------
describe("export callback - light theme", () => {
  it("renders SVG, converts to PNG, and saves file", async () => {
    const pngData = new Uint8Array([137, 80, 78, 71]);
    mockSvgToPngBytes.mockResolvedValue(pngData);
    mockSave.mockResolvedValue("/output/mindmap.png");
    mockWriteFile.mockResolvedValue(undefined);

    setupMarkmapExport(container, "# Hello");
    await capturedDoExport!("light");

    expect(mockTransform).toHaveBeenCalledWith("# Hello");
    const [svg, scale, bg] = mockSvgToPngBytes.mock.calls[0];
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain("# Hello");
    expect(svg).toContain("background-color: rgb(255, 255, 255)");
    expect([scale, bg]).toEqual([2, "#ffffff"]);
    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: "mindmap.png",
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    expect(mockWriteFile).toHaveBeenCalledWith("/output/mindmap.png", pngData);
  });

  it("removes the off-screen render container after export", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue(null);
    const before = document.body.childElementCount;

    setupMarkmapExport(container, "# Hello");
    await capturedDoExport!("light");

    expect(document.body.childElementCount).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Export callback - dark theme
// ---------------------------------------------------------------------------
describe("export callback - dark theme", () => {
  it("uses dark background color", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("/output/mindmap.png");
    mockWriteFile.mockResolvedValue(undefined);

    setupMarkmapExport(container, "# Dark");
    await capturedDoExport!("dark");

    const [svg, scale, bg] = mockSvgToPngBytes.mock.calls[0];
    expect(svg).toContain("# Dark");
    expect(svg).toContain("background-color: rgb(30, 30, 30)");
    expect([scale, bg]).toEqual([2, "#1e1e1e"]);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------
describe("error paths", () => {
  it("returns early when the source is empty", async () => {
    setupMarkmapExport(container, "");
    await capturedDoExport!("light");

    expect(mockDiagramWarn).toHaveBeenCalledWith("render returned no SVG");
    expect(mockSvgToPngBytes).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns early when the source is whitespace only", async () => {
    setupMarkmapExport(container, "  \n\t ");
    await capturedDoExport!("light");

    expect(mockTransform).not.toHaveBeenCalled();
    expect(mockDiagramWarn).toHaveBeenCalledWith("render returned no SVG");
    expect(mockSvgToPngBytes).not.toHaveBeenCalled();
  });

  it("returns early when the markmap renderer throws", async () => {
    mockCreate.mockImplementation(() => {
      throw new Error("layout failed");
    });

    setupMarkmapExport(container, "# Broken");
    await capturedDoExport!("light");

    expect(mockDiagramWarn).toHaveBeenCalledWith("render returned no SVG");
    expect(mockSvgToPngBytes).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns early when SVG to PNG conversion fails", async () => {
    mockSvgToPngBytes.mockRejectedValue(new Error("Canvas error"));

    setupMarkmapExport(container, "# Test");
    await capturedDoExport!("light");

    expect(mockDiagramWarn).toHaveBeenCalledWith(
      "SVG->PNG conversion failed",
      expect.any(Error),
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns early when user cancels save dialog", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue(null);

    setupMarkmapExport(container, "# Test");
    await capturedDoExport!("light");

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("logs warning when file write fails", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("/output/mindmap.png");
    mockWriteFile.mockRejectedValue(new Error("Disk full"));

    setupMarkmapExport(container, "# Test");
    await capturedDoExport!("light");

    expect(mockDiagramWarn).toHaveBeenCalledWith(
      "failed to write file",
      expect.any(Error),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("trims surrounding whitespace before transforming", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue(null);

    setupMarkmapExport(container, "\n  # Padded  \n");
    await capturedDoExport!("light");

    expect(mockTransform).toHaveBeenCalledWith("# Padded");
  });

  it("handles unicode/CJK content in markmap source", async () => {
    const source = "# \u4F60\u597D\u4E16\u754C";
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("/out.png");
    mockWriteFile.mockResolvedValue(undefined);

    setupMarkmapExport(container, source);
    await capturedDoExport!("light");

    expect(mockTransform).toHaveBeenCalledWith(source);
    expect(mockSvgToPngBytes.mock.calls[0][0]).toContain(source);
  });
});
