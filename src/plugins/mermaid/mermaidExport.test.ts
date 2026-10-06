/**
 * Tests for Mermaid Export
 *
 * Covers the setupMermaidExport function which renders mermaid SVG,
 * converts to PNG, and saves via Tauri dialog. The real mermaid export
 * renderer (./plugin) runs; only the third-party `mermaid` package underneath
 * it is replaced, because mermaid's layout needs a real layout engine.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const mockSave = vi.fn();
const mockWriteFile = vi.fn();
const mockMermaidRender = vi.fn();
const mockMermaidInitialize = vi.fn();
const mockSvgToPngBytes = vi.fn();
const mockDiagramWarn = vi.fn();
const mockSetupDiagramExport = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => mockMermaidInitialize(...args),
    render: (...args: unknown[]) => mockMermaidRender(...args),
  },
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

import { setupMermaidExport } from "./mermaidExport";

let container: HTMLElement;
let capturedDoExport: ((theme: "light" | "dark") => Promise<void>) | null;

beforeEach(() => {
  vi.clearAllMocks();
  // Echo the source into the SVG so assertions see what the renderer was given.
  mockMermaidRender.mockImplementation(async (_id: string, source: string) => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>' + source + "</text></svg>",
  }));
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

/** The mermaid theme of the most recent export (non-live) `initialize` call. */
function lastExportTheme(): string | undefined {
  const themes = mockMermaidInitialize.mock.calls
    .map(([cfg]) => (cfg as { theme?: string }).theme)
    .filter((theme) => theme !== "base");
  return themes.at(-1);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
describe("setupMermaidExport", () => {
  it("calls setupDiagramExport with container and callback", () => {
    setupMermaidExport(container, "graph TD; A-->B");

    expect(mockSetupDiagramExport).toHaveBeenCalledWith(
      container,
      expect.any(Function),
    );
  });

  it("returns the ExportInstance from setupDiagramExport", () => {
    const mockDestroy = vi.fn();
    mockSetupDiagramExport.mockReturnValue({ destroy: mockDestroy });

    const instance = setupMermaidExport(container, "graph TD; A-->B");
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
    mockSave.mockResolvedValue("/output/diagram.png");
    mockWriteFile.mockResolvedValue(undefined);

    setupMermaidExport(container, "graph TD; A-->B");
    await capturedDoExport!("light");

    expect(mockMermaidRender).toHaveBeenCalledWith(
      expect.stringMatching(/^export-/),
      "graph TD; A-->B",
    );
    expect(lastExportTheme()).toBe("default");
    const [svg, scale, bg] = mockSvgToPngBytes.mock.calls[0];
    expect(svg).toContain("graph TD; A-->B");
    expect([scale, bg]).toEqual([2, "#ffffff"]);
    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: "diagram.png",
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    expect(mockWriteFile).toHaveBeenCalledWith("/output/diagram.png", pngData);
  });
});

// ---------------------------------------------------------------------------
// Export callback - dark theme
// ---------------------------------------------------------------------------
describe("export callback - dark theme", () => {
  it("renders with the dark mermaid theme on a dark background", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("/output/diagram.png");
    mockWriteFile.mockResolvedValue(undefined);

    setupMermaidExport(container, "graph LR; X-->Y");
    await capturedDoExport!("dark");

    expect(lastExportTheme()).toBe("dark");
    const [svg, scale, bg] = mockSvgToPngBytes.mock.calls[0];
    expect(svg).toContain("graph LR; X-->Y");
    expect([scale, bg]).toEqual([2, "#1e1e1e"]);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------
describe("error paths", () => {
  it("returns early when mermaid rejects the diagram", async () => {
    mockMermaidRender.mockRejectedValue(new Error("Parse error on line 1"));

    setupMermaidExport(container, "invalid");
    await capturedDoExport!("light");

    expect(mockDiagramWarn).toHaveBeenCalledWith("render returned no SVG");
    expect(mockSvgToPngBytes).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("restores the live mermaid config after a failed export render", async () => {
    mockMermaidRender.mockRejectedValue(new Error("Parse error"));

    setupMermaidExport(container, "invalid");
    await capturedDoExport!("dark");

    const lastConfig = mockMermaidInitialize.mock.calls.at(-1)?.[0] as { theme?: string };
    expect(lastConfig.theme).toBe("base");
  });

  it("returns early when SVG to PNG conversion fails", async () => {
    mockSvgToPngBytes.mockRejectedValue(new Error("Canvas error"));

    setupMermaidExport(container, "graph TD; A-->B");
    await capturedDoExport!("light");

    expect(mockDiagramWarn).toHaveBeenCalledWith(
      expect.stringContaining("PNG conversion failed"),
      expect.any(Error),
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns early when user cancels save dialog", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue(null);

    setupMermaidExport(container, "graph TD; A-->B");
    await capturedDoExport!("light");

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns early when save dialog returns empty string", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("");

    setupMermaidExport(container, "graph TD; A-->B");
    await capturedDoExport!("light");

    // Empty string is falsy, so writeFile should not be called
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("logs warning when file write fails", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("/output/diagram.png");
    mockWriteFile.mockRejectedValue(new Error("Permission denied"));

    setupMermaidExport(container, "graph TD; A-->B");
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
  it("passes empty mermaid source through to the renderer", async () => {
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue(null);

    setupMermaidExport(container, "");
    await capturedDoExport!("light");

    expect(mockMermaidRender).toHaveBeenCalledWith(expect.any(String), "");
  });

  it("handles complex mermaid diagram source", async () => {
    const source = `flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[OK]
    B -->|No| D[End]`;
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("/out.png");
    mockWriteFile.mockResolvedValue(undefined);

    setupMermaidExport(container, source);
    await capturedDoExport!("dark");

    expect(mockMermaidRender).toHaveBeenCalledWith(expect.any(String), source);
  });

  it("handles special characters and CJK in mermaid source", async () => {
    const source = 'graph TD; A["Label (parens) & 你好"]-->B';
    mockSvgToPngBytes.mockResolvedValue(new Uint8Array([1]));
    mockSave.mockResolvedValue("/out.png");
    mockWriteFile.mockResolvedValue(undefined);

    setupMermaidExport(container, source);
    await capturedDoExport!("light");

    expect(mockMermaidRender).toHaveBeenCalledWith(expect.any(String), source);
  });
});
