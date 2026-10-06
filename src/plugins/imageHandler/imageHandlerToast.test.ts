/**
 * Tests for imageHandlerToast — toast display for image paste confirmation.
 *
 * Covers:
 *   - tryTextImagePaste (entry point for text-based image paste detection)
 *   - Single image: URL, data URL, absolute path, home path, relative path
 *   - Multiple images: validation and multi-toast display
 *   - Toast callbacks: onConfirm inserts image, onDismiss pastes text
 *   - Edge cases: empty text, non-image text, failed validation, disconnected view
 *
 * The insert/paste half (imageHandlerInsert) runs for real against a real
 * ProseMirror view, so a confirmed toast is observed as block images in the
 * document and a dismissed one as pasted text. The boundaries are the host's
 * toast port, the path validation that reads the filesystem, and the dialog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks (must be before imports) ---

const mockDialogMessage = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => mockDialogMessage(...args),
}));

const mockShowToast = vi.fn();
const mockShowMultiToast = vi.fn();
// One seam member now, dispatching on whether a batch was passed — mirror
// that split here so the two toasts stay separately assertable.
vi.mock("@/plugins/shared/hostPopups", () => ({
  hostPopups: {
    showImagePasteToast: (r: { imageResults?: unknown[] }) =>
      r.imageResults ? mockShowMultiToast(r) : mockShowToast(r),
  },
}));

vi.mock("@/utils/debug", () => ({
  imageHandlerWarn: vi.fn(),
  imageHandlerError: vi.fn(),
}));

const mockIsViewConnected = vi.fn(() => true);
const mockValidateLocalPath = vi.fn(() => Promise.resolve(true));
const mockExpandHomePath = vi.fn((p: string) => Promise.resolve(p));
const mockGetToastAnchorRect = vi.fn(() => ({
  top: 100,
  left: 200,
  bottom: 120,
  right: 220,
}));

vi.mock("./imageHandlerUtils", () => ({
  isViewConnected: (...args: unknown[]) => mockIsViewConnected(...args),
  getToastAnchorRect: (...args: unknown[]) => mockGetToastAnchorRect(...args),
  // An unsaved document: there is no folder to copy a local image next to.
  getActiveFilePathForCurrentWindow: () => null,
}));

vi.mock("@/plugins/shared/localImagePath", () => ({
  validateLocalPath: (...args: unknown[]) => mockValidateLocalPath(...args),
  expandHomePath: (...args: unknown[]) => mockExpandHomePath(...args),
}));

// Real implementations for detection/parsing
vi.mock("@/utils/imagePathDetection", async () => {
  const actual = await vi.importActual<typeof import("@/utils/imagePathDetection")>(
    "@/utils/imagePathDetection"
  );
  return actual;
});

vi.mock("@/utils/multiImageParsing", async () => {
  const actual = await vi.importActual<typeof import("@/utils/multiImageParsing")>(
    "@/utils/multiImageParsing"
  );
  return actual;
});

// --- Imports (after mocks) ---

import { tryTextImagePaste } from "./imageHandlerToast";
import { EditorView } from "@tiptap/pm/view";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";

// --- Helpers ---

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    block_image: {
      group: "block",
      atom: true,
      attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
      toDOM: (node) => ["img", { src: node.attrs.src as string }],
    },
    text: {},
  },
});

const INITIAL_TEXT = "see selected text here";
const views: EditorView[] = [];

/** A real editor over one paragraph; `selection` is a text range in it. */
function createView(selection?: { from: number; to: number }): EditorView {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(INITIAL_TEXT)])]);
  const place = document.createElement("div");
  document.body.appendChild(place);
  const state = EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, selection?.from ?? 1, selection?.to ?? selection?.from ?? 1),
  });
  const view = new EditorView(place, { state });
  views.push(view);
  return view;
}

/** The block images in the document, in order. */
function images(view: EditorView): Array<{ src: string; alt: string }> {
  const out: Array<{ src: string; alt: string }> = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === "block_image") out.push({ src: node.attrs.src as string, alt: node.attrs.alt as string });
  });
  return out;
}

const text = (view: EditorView) => view.state.doc.textContent;
/** Nothing was inserted or pasted. */
const untouched = (view: EditorView) => images(view).length === 0 && text(view) === INITIAL_TEXT;

// --- Tests ---

describe("tryTextImagePaste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsViewConnected.mockReturnValue(true);
    mockValidateLocalPath.mockResolvedValue(true);
    mockExpandHomePath.mockImplementation((p: string) => Promise.resolve(p));
  });

  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.innerHTML = "";
  });

  // --- Returns false for non-image text ---

  it("returns false for empty text", () => {
    const view = createView();
    expect(tryTextImagePaste(view, "")).toBe(false);
  });

  it("returns false for plain text without image extension", () => {
    const view = createView();
    expect(tryTextImagePaste(view, "hello world")).toBe(false);
  });

  it("returns false for non-image URL", () => {
    const view = createView();
    expect(tryTextImagePaste(view, "https://example.com/page.html")).toBe(false);
  });

  it("returns false for non-image file path", () => {
    const view = createView();
    expect(tryTextImagePaste(view, "/Users/test/document.pdf")).toBe(false);
  });

  // --- Single image: URL ---

  it("returns true and shows toast for HTTP image URL", () => {
    const view = createView();
    const result = tryTextImagePaste(view, "https://example.com/photo.png");

    expect(result).toBe(true);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: "https://example.com/photo.png",
        imageType: "url",
      })
    );
  });

  it("returns true and shows toast for data URL image", () => {
    const view = createView();
    const result = tryTextImagePaste(view, "data:image/png;base64,abc123");

    expect(result).toBe(true);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        imageType: "url",
      })
    );
  });

  // --- Single image: Local paths (async validation) ---

  it("returns true for absolute local path (triggers async validation)", () => {
    const view = createView();
    const result = tryTextImagePaste(view, "/Users/test/photo.png");

    expect(result).toBe(true);
    // Toast shown asynchronously after validation
  });

  it("returns true for relative path (no validation needed)", () => {
    const view = createView();
    const result = tryTextImagePaste(view, "./assets/photo.png");

    expect(result).toBe(true);
  });

  it("returns true for home path", () => {
    const view = createView();
    const result = tryTextImagePaste(view, "~/Pictures/photo.png");

    expect(result).toBe(true);
  });

  // --- Single image: Toast callbacks ---

  it("toast onConfirm inserts the image as a block image", async () => {
    const view = createView();
    tryTextImagePaste(view, "https://example.com/photo.png");

    const toastArgs = mockShowToast.mock.calls[0][0];
    toastArgs.onConfirm();

    await vi.waitFor(() => {
      expect(images(view)).toEqual([{ src: "https://example.com/photo.png", alt: "" }]);
    });
    expect(text(view)).toBe(INITIAL_TEXT);
  });

  it("toast onDismiss pastes the text at the cursor instead", () => {
    const view = createView();
    tryTextImagePaste(view, "https://example.com/photo.png");

    const toastArgs = mockShowToast.mock.calls[0][0];
    toastArgs.onDismiss();

    expect(text(view)).toBe("https://example.com/photo.png" + INITIAL_TEXT);
    expect(images(view)).toEqual([]);
  });

  it("toast onConfirm does nothing when view is disconnected", async () => {
    const view = createView();
    tryTextImagePaste(view, "https://example.com/photo.png");

    mockIsViewConnected.mockReturnValue(false);
    const toastArgs = mockShowToast.mock.calls[0][0];
    toastArgs.onConfirm();

    await Promise.resolve();
    expect(untouched(view)).toBe(true);
  });

  it("toast onDismiss does nothing when view is disconnected", () => {
    const view = createView();
    tryTextImagePaste(view, "https://example.com/photo.png");

    mockIsViewConnected.mockReturnValue(false);
    const toastArgs = mockShowToast.mock.calls[0][0];
    toastArgs.onDismiss();

    expect(untouched(view)).toBe(true);
  });

  // --- Single image: captures selection state ---

  it("captures the selection at paste time: its text becomes the alt and is replaced", async () => {
    // "selected text" inside "see selected text here".
    const view = createView({ from: 5, to: 18 });

    tryTextImagePaste(view, "https://example.com/photo.png");
    // The user clicks elsewhere while the toast is up.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));

    const toastArgs = mockShowToast.mock.calls[0][0];
    toastArgs.onConfirm();

    await vi.waitFor(() => {
      expect(images(view)).toEqual([{ src: "https://example.com/photo.png", alt: "selected text" }]);
    });
    expect(text(view)).toBe("see  here");
  });

  it("inserts with an empty alt, and removes no text, when nothing is selected", async () => {
    const view = createView({ from: 10, to: 10 });

    tryTextImagePaste(view, "https://example.com/photo.png");

    const toastArgs = mockShowToast.mock.calls[0][0];
    toastArgs.onConfirm();

    await vi.waitFor(() => {
      expect(images(view)).toEqual([{ src: "https://example.com/photo.png", alt: "" }]);
    });
    expect(text(view)).toBe(INITIAL_TEXT);
  });

  // --- Async validation: absolute path ---

  it("shows toast after successful path validation", async () => {
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();

    tryTextImagePaste(view, "/Users/test/photo.png");

    // Wait for async validation
    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledTimes(1);
    });
  });

  it("pastes as text when path validation fails", async () => {
    mockValidateLocalPath.mockResolvedValue(false);
    const view = createView();

    tryTextImagePaste(view, "/Users/test/nonexistent.png");

    await vi.waitFor(() => {
      expect(text(view)).toBe("/Users/test/nonexistent.png" + INITIAL_TEXT);
    });
  });

  it("pastes as text when home path expansion fails", async () => {
    mockExpandHomePath.mockResolvedValue(null);
    const view = createView();

    tryTextImagePaste(view, "~/Pictures/photo.png");

    await vi.waitFor(() => {
      expect(text(view)).toBe("~/Pictures/photo.png" + INITIAL_TEXT);
    });
  });

  it("does not show toast if view disconnects during validation", async () => {
    // Start connected, disconnect after validation resolves
    mockValidateLocalPath.mockImplementation(async () => {
      mockIsViewConnected.mockReturnValue(false);
      return true;
    });
    const view = createView();

    tryTextImagePaste(view, "/Users/test/photo.png");

    await vi.waitFor(() => {
      expect(mockValidateLocalPath).toHaveBeenCalled();
    });
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  // --- Multiple images ---

  it("returns true for multiple image paths (newline-separated)", () => {
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";
    const result = tryTextImagePaste(view, pasted);

    expect(result).toBe(true);
  });

  it("shows multi-toast after validating multiple paths", async () => {
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalledTimes(1);
    });

    const toastArgs = mockShowMultiToast.mock.calls[0][0];
    expect(toastArgs.imageResults).toHaveLength(2);
  });

  it("multi-toast onConfirm inserts every image, in order", async () => {
    const view = createView();
    const pasted = "https://example.com/a.png\nhttps://example.com/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });

    const toastArgs = mockShowMultiToast.mock.calls[0][0];
    toastArgs.onConfirm();

    await vi.waitFor(() => {
      expect(images(view)).toEqual([
        { src: "https://example.com/a.png", alt: "" },
        { src: "https://example.com/b.jpg", alt: "" },
      ]);
    });
    expect(text(view)).toBe(INITIAL_TEXT);
  });

  it("multi-toast onConfirm for local files in an unsaved document warns and inserts nothing", async () => {
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();

    tryTextImagePaste(view, "/Users/test/a.png\n/Users/test/b.jpg");

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });

    mockShowMultiToast.mock.calls[0][0].onConfirm();

    // Copying needs a saved document to copy next to.
    await vi.waitFor(() => {
      expect(mockDialogMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "warning" }));
    });
    expect(untouched(view)).toBe(true);
  });

  it("multi-toast onDismiss calls pasteAsText", async () => {
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });

    const toastArgs = mockShowMultiToast.mock.calls[0][0];
    toastArgs.onDismiss();

    expect(text(view)).toBe(pasted + INITIAL_TEXT);
  });

  it("pastes as text when any path in multi-image is invalid", async () => {
    mockValidateLocalPath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/nonexistent.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(text(view)).toBe(pasted + INITIAL_TEXT);
    });
    expect(mockShowMultiToast).not.toHaveBeenCalled();
  });

  it("returns false when multi-line text has mixed image and non-image", () => {
    const view = createView();
    const pasted = "/Users/test/a.png\nhello world";

    const result = tryTextImagePaste(view, pasted);

    expect(result).toBe(false);
  });

  it("does not validate URL paths in multi-image (only local paths)", async () => {
    const view = createView();
    const pasted = "https://example.com/a.png\nhttps://example.com/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });
    expect(mockValidateLocalPath).not.toHaveBeenCalled();
  });

  it("multi-toast onConfirm does nothing when view is disconnected", async () => {
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });

    mockIsViewConnected.mockReturnValue(false);
    const toastArgs = mockShowMultiToast.mock.calls[0][0];
    toastArgs.onConfirm();

    await Promise.resolve();
    expect(untouched(view)).toBe(true);
    expect(mockDialogMessage).not.toHaveBeenCalled();
  });

  // --- Edge cases ---

  it("handles Windows absolute path", () => {
    const view = createView();
    const result = tryTextImagePaste(view, "C:\\Users\\test\\photo.png");

    expect(result).toBe(true);
  });

  it("handles image URL with query parameters", () => {
    const view = createView();
    const result = tryTextImagePaste(view, "https://example.com/photo.png?width=100");

    expect(result).toBe(true);
    expect(mockShowToast).toHaveBeenCalled();
  });

  it("shows toast with correct imageType for local paths", async () => {
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();

    tryTextImagePaste(view, "/Users/test/photo.png");

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalled();
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        imageType: "localPath",
      })
    );
  });

  it("falls back to pasteAsText on validation error (catch path)", async () => {
    mockValidateLocalPath.mockRejectedValue(new Error("FS error"));
    const view = createView();

    tryTextImagePaste(view, "/Users/test/photo.png");

    await vi.waitFor(() => {
      expect(text(view)).not.toBe(INITIAL_TEXT);
    });
  });

  // --- Relative path (no validation needed for single image) ---

  it("shows toast for relative path without validating", async () => {
    const view = createView();
    tryTextImagePaste(view, "./assets/photo.png");

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledTimes(1);
    });
    // Relative paths skip validation entirely
    expect(mockValidateLocalPath).not.toHaveBeenCalled();
    expect(mockExpandHomePath).not.toHaveBeenCalled();
  });

  // --- Home path validation with expand + validate ---

  it("validates expanded home path before showing toast", async () => {
    mockExpandHomePath.mockResolvedValue("/Users/me/Pictures/photo.png");
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();

    tryTextImagePaste(view, "~/Pictures/photo.png");

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalled();
    });
    expect(mockExpandHomePath).toHaveBeenCalledWith("~/Pictures/photo.png");
    expect(mockValidateLocalPath).toHaveBeenCalledWith("/Users/me/Pictures/photo.png");
  });

  it("pastes as text when home path is valid but file does not exist", async () => {
    mockExpandHomePath.mockResolvedValue("/Users/me/Pictures/photo.png");
    mockValidateLocalPath.mockResolvedValue(false);
    const view = createView();

    tryTextImagePaste(view, "~/Pictures/photo.png");

    await vi.waitFor(() => {
      expect(text(view)).not.toBe(INITIAL_TEXT);
    });
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("does not paste as text when view disconnects during home path validation", async () => {
    mockExpandHomePath.mockImplementation(async () => {
      mockIsViewConnected.mockReturnValue(false);
      return null;
    });
    const view = createView();

    tryTextImagePaste(view, "~/Pictures/photo.png");

    await vi.waitFor(() => {
      expect(mockExpandHomePath).toHaveBeenCalled();
    });
    // View disconnected, so pasteAsText should NOT be called
    expect(untouched(view)).toBe(true);
  });

  // --- Multi-image: home path and relative path branches ---

  it("validates home paths in multi-image and shows multi-toast", async () => {
    mockExpandHomePath.mockResolvedValue("/Users/me/a.png");
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();
    const pasted = "~/a.png\n~/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });
  });

  it("pastes as text when home path expansion fails in multi-image", async () => {
    mockExpandHomePath.mockResolvedValue(null);
    const view = createView();
    const pasted = "~/a.png\n~/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(text(view)).not.toBe(INITIAL_TEXT);
    });
    expect(mockShowMultiToast).not.toHaveBeenCalled();
  });

  it("accepts relative paths in multi-image without validation", async () => {
    const view = createView();
    const pasted = "./img/a.png\n./img/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });
    expect(mockValidateLocalPath).not.toHaveBeenCalled();
  });

  it("does not show multi-toast if view disconnects during validation", async () => {
    mockValidateLocalPath.mockImplementation(async () => {
      mockIsViewConnected.mockReturnValue(false);
      return true;
    });
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockValidateLocalPath).toHaveBeenCalled();
    });
    expect(mockShowMultiToast).not.toHaveBeenCalled();
  });

  it("falls back to pasteAsText on multi-image validation error (catch path)", async () => {
    mockValidateLocalPath.mockRejectedValue(new Error("FS error"));
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(text(view)).not.toBe(INITIAL_TEXT);
    });
  });

  it("does not paste as text on multi-image error when view is disconnected", async () => {
    mockIsViewConnected.mockReturnValue(false);
    mockValidateLocalPath.mockRejectedValue(new Error("FS error"));
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockValidateLocalPath).toHaveBeenCalled();
    });
    expect(untouched(view)).toBe(true);
  });

  it("multi-toast onDismiss does nothing when view is disconnected", async () => {
    mockValidateLocalPath.mockResolvedValue(true);
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/b.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockShowMultiToast).toHaveBeenCalled();
    });

    mockIsViewConnected.mockReturnValue(false);
    const toastArgs = mockShowMultiToast.mock.calls[0][0];
    toastArgs.onDismiss();

    expect(untouched(view)).toBe(true);
  });

  // --- paths.length === 0 (line 37 true branch) ---

  it("returns false when text has no parseable paths (paths.length === 0)", () => {
    const view = createView();
    // A string with only whitespace — parseMultiplePaths produces no paths
    const result = tryTextImagePaste(view, "   \t\n   ");

    expect(result).toBe(false);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  // --- Single-image catch: view NOT connected (line 61 else branch) ---

  it("does not paste as text on single-image catch when view is disconnected", async () => {
    mockIsViewConnected.mockReturnValue(false);
    mockValidateLocalPath.mockRejectedValue(new Error("FS error"));
    const view = createView();

    tryTextImagePaste(view, "/Users/test/photo.png");

    await vi.waitFor(() => {
      expect(mockValidateLocalPath).toHaveBeenCalled();
    });

    // View disconnected → else branch at line 61 → pasteAsText NOT called
    expect(untouched(view)).toBe(true);
  });

  // --- Single-image validation fails + view disconnected (line 109 else branch) ---

  it("does not paste as text when view disconnects before path-not-found paste (line 109 else)", async () => {
    // Path validation succeeds (valid=true → expandHomePath not needed for absolutePath),
    // but for absolutePath the validate resolves false AND view is disconnected.
    mockIsViewConnected.mockReturnValue(false);
    mockValidateLocalPath.mockResolvedValue(false);
    const view = createView();

    tryTextImagePaste(view, "/Users/test/nonexistent.png");

    await vi.waitFor(() => {
      expect(mockValidateLocalPath).toHaveBeenCalled();
    });

    // View disconnected → else branch at line 109 → pasteAsText NOT called
    expect(untouched(view)).toBe(true);
  });

  // --- Multi-image: some invalid + view disconnected (line 204 else branch) ---

  it("does not paste as text when view disconnects before multi-image invalid paste (line 204 else)", async () => {
    mockIsViewConnected.mockReturnValue(false);
    // First path valid, second invalid
    mockValidateLocalPath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const view = createView();
    const pasted = "/Users/test/a.png\n/Users/test/nonexistent.jpg";

    tryTextImagePaste(view, pasted);

    await vi.waitFor(() => {
      expect(mockValidateLocalPath).toHaveBeenCalled();
    });

    // Some invalid AND view disconnected → else branch at line 204 → pasteAsText NOT called
    expect(untouched(view)).toBe(true);
    expect(mockShowMultiToast).not.toHaveBeenCalled();
  });
});
