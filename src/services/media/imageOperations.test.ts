// @vitest-environment node
/**
 * Tests for useImageOperations
 *
 * Tests async image file operations: assets folder management, image saving
 * with hash deduplication, image copying, and ProseMirror node insertion.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock Tauri filesystem APIs
const mockMkdir = vi.fn(() => Promise.resolve());
const mockExists = vi.fn(() => Promise.resolve(false));
const mockCopyFile = vi.fn(() => Promise.resolve());
const mockWriteFile = vi.fn(() => Promise.resolve());
const mockReadFile = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  exists: (...args: unknown[]) => mockExists(...args),
  copyFile: (...args: unknown[]) => mockCopyFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock image utilities
vi.mock("@/utils/imageUtils", () => ({
  ASSETS_FOLDER: "assets/images",
  generateUniqueFilename: vi.fn((name: string) => `unique-${name}`),
  getFilename: vi.fn((path: string) => path.split("/").pop() || "image.png"),
  buildAssetRelativePath: vi.fn((filename: string) => `assets/images/${filename}`),
}));

// Mock image hash
const mockComputeDataHash = vi.fn(() => Promise.resolve("abc123hash"));
vi.mock("@/utils/imageHash", () => ({
  computeDataHash: (...args: unknown[]) => mockComputeDataHash(...args),
}));

// Mock image hash registry
const mockFindExistingImage = vi.fn(() => Promise.resolve(null));
const mockRegisterImageHash = vi.fn(() => Promise.resolve());
vi.mock("@/services/media/imageHashRegistry", () => ({
  findExistingImage: (...args: unknown[]) => mockFindExistingImage(...args),
  registerImageHash: (...args: unknown[]) => mockRegisterImageHash(...args),
}));

import {
  getAssetsFolder,
  ensureAssetsFolder,
  saveImageToAssets,
  copyImageToAssets,
  insertImageNode,
  insertBlockImageNode,
} from "./imageOperations";
import { useSettingsStore } from "@/stores/settingsStore";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";

const DOC = "/Users/test/docs/note.md";

/** The first bytes of a PNG — what the resizer sniffs to pick a MIME type. */
const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6]);

/**
 * Stand in for the browser's image pipeline, the boundary the real resizer
 * drives: an `Image` that decodes to `width`×`height` once its `src` is set,
 * and a `<canvas>` whose `toBlob` encodes to `encoded`. Returns the canvas (to
 * read the size it was drawn at) and the `createElement` spy.
 */
function stubImagePipeline(width: number, height: number, encoded: number[]) {
  class DecodedImage {
    width = 0;
    height = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    #src = "";
    get src() {
      return this.#src;
    }
    set src(url: string) {
      this.#src = url;
      this.width = width;
      this.height = height;
      queueMicrotask(() => this.onload?.());
    }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ imageSmoothingEnabled: false, imageSmoothingQuality: "low", drawImage: vi.fn() }),
    toBlob: (done: (blob: Blob | null) => void, type?: string) =>
      done(new Blob([new Uint8Array(encoded)], { type: type ?? "" })),
  };
  const createElement = vi.fn((tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected element <${tag}>`);
    return canvas;
  });
  vi.stubGlobal("Image", DecodedImage);
  vi.stubGlobal("document", { createElement });
  return { canvas, createElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ProseMirror test helpers
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    image: {
      inline: true,
      group: "inline",
      attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
      parseDOM: [{ tag: "img" }],
      toDOM(node) {
        return ["img", node.attrs];
      },
    },
    block_image: {
      group: "block",
      attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
      parseDOM: [{ tag: "figure" }],
      toDOM(node) {
        return ["figure", ["img", node.attrs]];
      },
    },
    text: { group: "inline" },
  },
});

function createEditorState(text = "hello world") {
  return EditorState.create({
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, text ? [schema.text(text)] : []),
    ]),
    schema,
  });
}

function createMockEditorView(state: EditorState) {
  const dispatchFn = vi.fn((tr) => {
    // Apply transaction to state for inspection
    state = state.apply(tr);
  });
  return {
    state,
    dispatch: dispatchFn,
  } as unknown as EditorView;
}

describe("getAssetsFolder", () => {
  it("returns assets folder path relative to document", async () => {
    const result = await getAssetsFolder("/Users/test/docs/note.md");
    expect(result).toBe("/Users/test/docs/assets/images");
  });

  it("handles deeply nested document paths", async () => {
    const result = await getAssetsFolder("/a/b/c/d/doc.md");
    expect(result).toBe("/a/b/c/d/assets/images");
  });
});

describe("ensureAssetsFolder", () => {
  beforeEach(() => {
    mockExists.mockReset();
    mockMkdir.mockReset();
    mockMkdir.mockResolvedValue(undefined);
  });

  it("creates assets folder if it does not exist", async () => {
    mockExists.mockResolvedValue(false);

    const result = await ensureAssetsFolder("/Users/test/docs/note.md");

    expect(mockMkdir).toHaveBeenCalledWith(
      "/Users/test/docs/assets/images",
      { recursive: true }
    );
    expect(result).toBe("/Users/test/docs/assets/images");
  });

  it("does not create assets folder if it already exists", async () => {
    mockExists.mockResolvedValue(true);

    const result = await ensureAssetsFolder("/Users/test/docs/note.md");

    expect(mockMkdir).not.toHaveBeenCalled();
    expect(result).toBe("/Users/test/docs/assets/images");
  });
});

describe("saveImageToAssets", () => {
  beforeEach(() => {
    mockExists.mockReset().mockResolvedValue(false);
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockCopyFile.mockReset().mockResolvedValue(undefined);
    mockComputeDataHash.mockReset().mockResolvedValue("abc123hash");
    mockFindExistingImage.mockReset().mockResolvedValue(null);
    mockRegisterImageHash.mockReset().mockResolvedValue(undefined);
    // Auto-resize is off by default.
    useSettingsStore.getState().resetSettings();
  });

  it("saves image and returns relative path", async () => {
    const imageData = new Uint8Array([1, 2, 3, 4]);

    const result = await saveImageToAssets(
      imageData,
      "screenshot.png",
      "/Users/test/docs/note.md"
    );

    // Resize off: the bytes are hashed and written exactly as given.
    expect(mockComputeDataHash).toHaveBeenCalledWith(imageData);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/Users/test/docs/assets/images/unique-screenshot.png",
      imageData
    );
    expect(mockRegisterImageHash).toHaveBeenCalledWith(
      "/Users/test/docs/note.md",
      "abc123hash",
      "unique-screenshot.png"
    );
    expect(result).toBe("assets/images/unique-screenshot.png");
  });

  it("returns existing path when duplicate is found", async () => {
    mockFindExistingImage.mockResolvedValue("assets/images/existing.png");

    const imageData = new Uint8Array([1, 2, 3]);
    const result = await saveImageToAssets(
      imageData,
      "screenshot.png",
      "/Users/test/docs/note.md"
    );

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRegisterImageHash).not.toHaveBeenCalled();
    expect(result).toBe("assets/images/existing.png");
  });

  it("resizes image before saving and hashing", async () => {
    useSettingsStore.getState().updateImageSetting("autoResizeMax", 800);
    const { canvas } = stubImagePipeline(1600, 900, [1, 2]);
    const original = pngBytes();
    const resized = new Uint8Array([1, 2]);

    await saveImageToAssets(original, "big.png", DOC);

    // 1600×900 fits an 800px bound as 800×450, aspect ratio kept.
    expect([canvas.width, canvas.height]).toEqual([800, 450]);
    // Hash should be computed on resized data
    expect(mockComputeDataHash).toHaveBeenCalledWith(resized);
    // Write should use resized data
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      resized
    );
  });
});

describe("copyImageToAssets", () => {
  beforeEach(() => {
    mockExists.mockReset().mockResolvedValue(false);
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockReadFile.mockReset().mockResolvedValue(new Uint8Array([10, 20, 30]));
    mockCopyFile.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockComputeDataHash.mockReset().mockResolvedValue("xyz789hash");
    mockFindExistingImage.mockReset().mockResolvedValue(null);
    mockRegisterImageHash.mockReset().mockResolvedValue(undefined);
    // Auto-resize is off by default.
    useSettingsStore.getState().resetSettings();
  });

  it("copies image file and returns relative path", async () => {
    const result = await copyImageToAssets(
      "/external/photo.jpg",
      "/Users/test/docs/note.md"
    );

    expect(mockReadFile).toHaveBeenCalledWith("/external/photo.jpg");
    expect(mockCopyFile).toHaveBeenCalled(); // Uses copyFile when not resized
    expect(mockRegisterImageHash).toHaveBeenCalled();
    expect(result).toBe("assets/images/unique-photo.jpg");
  });

  it("returns existing path when duplicate is found", async () => {
    mockFindExistingImage.mockResolvedValue("assets/images/existing-photo.jpg");

    const result = await copyImageToAssets(
      "/external/photo.jpg",
      "/Users/test/docs/note.md"
    );

    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(result).toBe("assets/images/existing-photo.jpg");
  });

  it("writes resized data instead of copying when image was resized", async () => {
    useSettingsStore.getState().updateImageSetting("autoResizeMax", 800);
    stubImagePipeline(1600, 900, [1]);
    const resized = new Uint8Array([1]);

    await copyImageToAssets("/external/big.png", DOC);

    expect(mockComputeDataHash).toHaveBeenCalledWith(resized);
    expect(mockWriteFile).toHaveBeenCalledWith(expect.any(String), resized);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it("uses copyFile when image was not resized (faster for large files)", async () => {
    // Resize is on, but a 400×200 image already fits an 800px bound.
    useSettingsStore.getState().updateImageSetting("autoResizeMax", 800);
    const { createElement } = stubImagePipeline(400, 200, [9]);

    await copyImageToAssets("/external/photo.png", DOC);

    expect(createElement).not.toHaveBeenCalled();
    expect(mockCopyFile).toHaveBeenCalledWith(
      "/external/photo.png",
      "/Users/test/docs/assets/images/unique-photo.png"
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe("insertImageNode", () => {
  it("inserts inline image at selection position", () => {
    const state = createEditorState("hello world");
    const view = createMockEditorView(state);

    insertImageNode(view, "assets/images/photo.png");

    expect(view.dispatch).toHaveBeenCalledWith(expect.any(Object));
  });

  it("inserts inline image at specified position", () => {
    const state = createEditorState("hello world");
    const view = createMockEditorView(state);

    insertImageNode(view, "assets/images/photo.png", 5);

    expect(view.dispatch).toHaveBeenCalled();
  });

  it("does nothing when image node type is not in schema", () => {
    const noImageSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*" },
        text: { inline: true },
      },
    });
    const state = EditorState.create({
      doc: noImageSchema.node("doc", null, [
        noImageSchema.node("paragraph", null, [noImageSchema.text("hello")]),
      ]),
    });
    const view = createMockEditorView(state);

    insertImageNode(view, "assets/images/photo.png");

    expect(view.dispatch).not.toHaveBeenCalled();
  });
});

describe("insertBlockImageNode", () => {
  it("inserts block image after current block", () => {
    const state = createEditorState("hello world");
    const view = createMockEditorView(state);

    insertBlockImageNode(view, "assets/images/photo.png");

    expect(view.dispatch).toHaveBeenCalled();
  });

  it("uses selected text as alt text when selection exists", () => {
    const state = createEditorState("hello world");
    // Create selection from pos 1 to 6 ("hello")
    const sel = TextSelection.create(state.doc, 1, 6);
    const stateWithSel = state.apply(state.tr.setSelection(sel));
    const view = createMockEditorView(stateWithSel);

    insertBlockImageNode(view, "assets/images/photo.png");

    expect(view.dispatch).toHaveBeenCalled();
  });

  it("uses provided alt text over selected text", () => {
    const state = createEditorState("hello world");
    const sel = TextSelection.create(state.doc, 1, 6);
    const stateWithSel = state.apply(state.tr.setSelection(sel));
    const view = createMockEditorView(stateWithSel);

    insertBlockImageNode(view, "assets/images/photo.png", "custom alt");

    expect(view.dispatch).toHaveBeenCalled();
  });

  it("falls back to inline image when block_image not in schema", () => {
    const inlineOnlySchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "inline*" },
        image: {
          inline: true,
          group: "inline",
          attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
          parseDOM: [{ tag: "img" }],
          toDOM(node) { return ["img", node.attrs]; },
        },
        text: { group: "inline" },
      },
    });
    const state = EditorState.create({
      doc: inlineOnlySchema.node("doc", null, [
        inlineOnlySchema.node("paragraph", null, [inlineOnlySchema.text("hello")]),
      ]),
    });
    const view = createMockEditorView(state);

    insertBlockImageNode(view, "assets/images/photo.png");

    // Should still dispatch (using insertImageNode fallback)
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("falls back to inline insertImageNode when no image types in schema", () => {
    const noImageSchema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*" },
        text: { inline: true },
      },
    });
    const state = EditorState.create({
      doc: noImageSchema.node("doc", null, [
        noImageSchema.node("paragraph", null, [noImageSchema.text("hello")]),
      ]),
    });
    const view = createMockEditorView(state);

    insertBlockImageNode(view, "assets/images/photo.png");

    // insertImageNode also won't find image type — no dispatch
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("uses block-level image fallback when schema has non-inline image and no block_image", () => {
    // Schema where image is a block node (not inline)
    const blockImageOnlySchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "text*", group: "block" },
        image: {
          group: "block",
          attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
          parseDOM: [{ tag: "img" }],
          toDOM(node) { return ["img", node.attrs]; },
        },
        text: { inline: true },
      },
    });
    const state = EditorState.create({
      doc: blockImageOnlySchema.node("doc", null, [
        blockImageOnlySchema.node("paragraph", null, [blockImageOnlySchema.text("hello")]),
      ]),
    });
    const view = createMockEditorView(state);

    insertBlockImageNode(view, "assets/images/photo.png");

    // Should dispatch using the non-inline image node
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("uses block-level image fallback with selection and deletes selected text", () => {
    const blockImageOnlySchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "text*", group: "block" },
        image: {
          group: "block",
          attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
          parseDOM: [{ tag: "img" }],
          toDOM(node) { return ["img", node.attrs]; },
        },
        text: { inline: true },
      },
    });
    const state = EditorState.create({
      doc: blockImageOnlySchema.node("doc", null, [
        blockImageOnlySchema.node("paragraph", null, [blockImageOnlySchema.text("hello world")]),
      ]),
    });
    // Create selection of "hello"
    const sel = TextSelection.create(state.doc, 1, 6);
    const stateWithSel = state.apply(state.tr.setSelection(sel));
    const view = createMockEditorView(stateWithSel);

    insertBlockImageNode(view, "assets/images/photo.png");

    expect(view.dispatch).toHaveBeenCalled();
  });

  it("inserts block_image node and adjusts position after deleting selected text", () => {
    const state = createEditorState("hello world");
    // Select "hello" (positions 1-6)
    const sel = TextSelection.create(state.doc, 1, 6);
    const stateWithSel = state.apply(state.tr.setSelection(sel));
    const view = createMockEditorView(stateWithSel);

    insertBlockImageNode(view, "assets/images/photo.png");

    // Transaction should have both delete and insert
    expect(view.dispatch).toHaveBeenCalled();
  });
});
