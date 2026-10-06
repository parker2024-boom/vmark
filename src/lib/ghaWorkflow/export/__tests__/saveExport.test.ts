// RW-7 (L3) — wire GHA workflow export to UI
//
// Tests the side-effecting export glue: clipboard copy for Mermaid, and
// data-URI → bytes → Tauri save-dialog → writeFile for SVG/PNG. The real
// exportCanvas runs against a jsdom viewport; only the rasterizing package
// (html-to-image) and the Tauri plugins are mocked, so viewport lookup and
// format dispatch are exercised for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));
vi.mock("html-to-image", () => ({
  toPng: vi.fn(),
  toSvg: vi.fn(),
}));

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { toPng, toSvg } from "html-to-image";
import { copyMermaid, saveImage } from "../saveExport";

const mockSave = save as unknown as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as unknown as ReturnType<typeof vi.fn>;
const mockToPng = toPng as unknown as ReturnType<typeof vi.fn>;
const mockToSvg = toSvg as unknown as ReturnType<typeof vi.fn>;

function mountViewport(): HTMLElement {
  const el = document.createElement("div");
  el.className = "react-flow__viewport";
  document.body.appendChild(el);
  return el;
}

describe("copyMermaid", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it("writes the mermaid string to the clipboard and returns true", async () => {
    const ok = await copyMermaid("flowchart TD\n  a-->b");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("flowchart TD\n  a-->b");
  });

  it("returns false when the clipboard write rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const ok = await copyMermaid("x");
    expect(ok).toBe(false);
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    mockSave.mockReset();
    mockWriteFile.mockReset();
    mockToPng.mockReset();
    mockToSvg.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders PNG, prompts a save dialog, and writes decoded base64 bytes", async () => {
    // "data:image/png;base64," + base64("PNG") => "UE5H"
    const viewport = mountViewport();
    mockToPng.mockResolvedValue("data:image/png;base64,UE5H");
    mockSave.mockResolvedValue("/tmp/workflow.png");

    const result = await saveImage("png");

    expect(result).toBe("saved");
    expect(mockToPng).toHaveBeenCalledWith(viewport, expect.objectContaining({ pixelRatio: 2 }));
    expect(mockToSvg).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "workflow.png" }),
    );
    const [, bytes] = mockWriteFile.mock.calls[0];
    expect(Array.from(bytes as Uint8Array)).toEqual([0x50, 0x4e, 0x47]); // "PNG"
  });

  it("decodes a URL-encoded (non-base64) SVG data URI", async () => {
    const viewport = mountViewport();
    mockToSvg.mockResolvedValue(
      "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E",
    );
    mockSave.mockResolvedValue("/tmp/workflow.svg");

    const result = await saveImage("svg");

    expect(result).toBe("saved");
    expect(mockToSvg).toHaveBeenCalledWith(viewport, expect.any(Object));
    const [, bytes] = mockWriteFile.mock.calls[0];
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("<svg></svg>");
  });

  it("returns 'cancelled' and does not write when the dialog is dismissed", async () => {
    mountViewport();
    mockToPng.mockResolvedValue("data:image/png;base64,UE5H");
    mockSave.mockResolvedValue(null);

    const result = await saveImage("png");

    expect(result).toBe("cancelled");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("propagates a missing-viewport failure so the caller can surface it", async () => {
    await expect(saveImage("svg")).rejects.toThrow(/react-flow__viewport/);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("propagates a rasterizer failure without writing", async () => {
    mountViewport();
    mockToPng.mockRejectedValue(new Error("canvas tainted"));
    await expect(saveImage("png")).rejects.toThrow(/canvas tainted/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
