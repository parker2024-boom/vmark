// WI-RA9A.2 — the one image-paste flow both editor modes run.
/**
 * Exercises the flow against a fake editor target and the real host seams.
 * Only what leaves the process is faked: Tauri's fs / path / dialog modules
 * (globally mocked in src/test/setup.ts) and the host's asset copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exists } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { message } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";
import type { ImagePathResult } from "@/utils/imagePathDetection";
import { bindHostNotify, resetHostNotify } from "./hostNotify";
import { bindHostPopups, resetHostPopups } from "./hostPopups";
import {
  allImagePathsExist,
  isViewConnected,
  offerImagePaste,
  resolveImagePathForInsert,
  resolveImagePathsForInsert,
  type ImageInsertHost,
  type ImagePasteTarget,
} from "./imagePasteResolve";

type ToastRequest = Parameters<NonNullable<Parameters<typeof bindHostPopups>[0]["showImagePasteToast"]>>[0];

const image = (type: ImagePathResult["type"], path: string, needsCopy = false): ImagePathResult => ({
  isImage: true,
  type,
  path,
  needsCopy,
  originalText: path,
});

const info = vi.fn<(message: string) => void>();
const error = vi.fn<(message: string) => void>();
const toasts: ToastRequest[] = [];

/** A fake editor whose every member is a spy; satisfies ImagePasteTarget structurally. */
function createTarget() {
  return {
    editorDom: document.createElement("div"),
    isConnected: vi.fn<ImagePasteTarget["isConnected"]>(() => true),
    anchorRect: vi.fn<ImagePasteTarget["anchorRect"]>(() => ({ top: 1, left: 2, bottom: 3, right: 4 })),
    pasteAsText: vi.fn<ImagePasteTarget["pasteAsText"]>(),
    insertSingle: vi.fn<ImagePasteTarget["insertSingle"]>(() => Promise.resolve()),
    insertMultiple: vi.fn<ImagePasteTarget["insertMultiple"]>(() => Promise.resolve()),
    log: {
      warn: vi.fn<ImagePasteTarget["log"]["warn"]>(),
      error: vi.fn<ImagePasteTarget["log"]["error"]>(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.length = 0;
  vi.mocked(exists).mockResolvedValue(true);
  vi.mocked(homeDir).mockResolvedValue("/Users/test");
  bindHostNotify({ info, error });
  bindHostPopups({ showImagePasteToast: (request) => toasts.push(request) });
});

afterEach(() => {
  resetHostNotify();
  resetHostPopups();
});

describe("isViewConnected", () => {
  it.each([
    ["null", null, false],
    ["undefined", undefined, false],
    ["a view with no dom", {}, false],
    ["a view whose dom is null", { dom: null }, false],
    ["a detached view", { dom: { isConnected: false } }, false],
    ["an attached view", { dom: { isConnected: true } }, true],
  ])("%s -> %s", (_label, view, expected) => {
    expect(isViewConnected(view)).toBe(expected);
  });

  it("treats a view whose dom getter throws as disconnected", () => {
    const broken = {
      get dom(): never {
        throw new Error("destroyed");
      },
    };
    expect(isViewConnected(broken)).toBe(false);
  });
});

describe("allImagePathsExist", () => {
  it("is true for an empty batch and for paths that cannot be checked, without touching the disk", async () => {
    expect(await allImagePathsExist([])).toBe(true);
    expect(
      await allImagePathsExist([
        image("url", "https://example.com/a.png"),
        image("dataUrl", "data:image/png;base64,AAAA"),
        image("relativePath", "./a.png"),
      ])
    ).toBe(true);
    expect(exists).not.toHaveBeenCalled();
  });

  it("checks a home path at its expanded location", async () => {
    expect(await allImagePathsExist([image("homePath", "~/图片/a.png")])).toBe(true);
    expect(vi.mocked(exists).mock.calls).toEqual([["/Users/test/图片/a.png"]]);
  });

  it("is false when any one checkable path is missing", async () => {
    vi.mocked(exists).mockImplementation((path) => Promise.resolve(path !== "/b.png"));
    const batch = [image("absolutePath", "/a.png"), image("absolutePath", "/b.png"), image("url", "https://x/c.png")];
    expect(await allImagePathsExist(batch)).toBe(false);
  });

  it("is false when the home directory cannot be resolved, without checking that path", async () => {
    vi.mocked(homeDir).mockRejectedValue(new Error("no home"));
    expect(await allImagePathsExist([image("homePath", "~/a.png")])).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });
});

describe("resolveImagePathForInsert", () => {
  const copyImage = vi.fn<ImageInsertHost["copyImage"]>();
  const logError = vi.fn();
  const host = (overrides: Partial<ImageInsertHost> = {}): ImageInsertHost => ({
    documentPath: "/docs/note.md",
    copyToAssets: true,
    copyImage,
    logError,
    ...overrides,
  });

  beforeEach(() => {
    copyImage.mockResolvedValue("assets/a.png");
  });

  it("returns a path that needs no copy as it is", async () => {
    const url = image("url", "https://example.com/a.png");
    expect(await resolveImagePathForInsert(url, host({ documentPath: null }))).toBe(url.path);
    expect(copyImage).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it("copies next to the document and returns the copied path", async () => {
    expect(await resolveImagePathForInsert(image("absolutePath", "/pics/a.png", true), host())).toBe("assets/a.png");
    expect(copyImage).toHaveBeenCalledWith("/pics/a.png", "/docs/note.md");
  });

  it("copies a home path from its expanded location", async () => {
    await resolveImagePathForInsert(image("homePath", "~/a.png", true), host());
    expect(copyImage).toHaveBeenCalledWith("/Users/test/a.png", "/docs/note.md");
  });

  it("asks the user to save first when copying into an unsaved document", async () => {
    const resolved = await resolveImagePathForInsert(
      image("absolutePath", "/a.png", true),
      host({ documentPath: null })
    );
    expect(resolved).toBeNull();
    expect(message).toHaveBeenCalledWith(i18n.t("dialog:unsavedDocument.messageInsertImagesLocal"), {
      title: i18n.t("dialog:unsavedDocument.title"),
      kind: "warning",
    });
    expect(copyImage).not.toHaveBeenCalled();
  });

  it.each([
    ["an absolute path", image("absolutePath", "/pics/a.png", true), "/pics/a.png"],
    ["a home path, expanded", image("homePath", "~/a.png", true), "/Users/test/a.png"],
  ])("links %s in place while copying is off, even in an unsaved document", async (_label, detection, expected) => {
    const resolved = await resolveImagePathForInsert(detection, host({ copyToAssets: false, documentPath: null }));
    expect(resolved).toBe(expected);
    expect(copyImage).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it.each([true, false])("reports an unresolvable home directory (copyToAssets=%s)", async (copyToAssets) => {
    vi.mocked(homeDir).mockRejectedValue(new Error("no home"));
    const resolved = await resolveImagePathForInsert(image("homePath", "~/a.png", true), host({ copyToAssets }));
    expect(resolved).toBeNull();
    expect(message).toHaveBeenCalledWith(i18n.t("dialog:toast.failedToResolveHomePath"), { kind: "error" });
    expect(copyImage).not.toHaveBeenCalled();
  });

  it("reports and logs a failed copy", async () => {
    const failure = new Error("disk full");
    copyImage.mockRejectedValue(failure);
    expect(await resolveImagePathForInsert(image("absolutePath", "/a.png", true), host())).toBeNull();
    expect(logError).toHaveBeenCalledWith("Failed to copy image to assets:", failure);
    expect(message).toHaveBeenCalledWith(i18n.t("dialog:toast.failedToCopyToAssets"), { kind: "error" });
  });

  it("resolves a batch in order, and gives up at the first image that cannot be inserted", async () => {
    copyImage.mockImplementation((source) => Promise.resolve(`assets${source}`));
    const batch = [image("absolutePath", "/a.png", true), image("url", "https://x/b.png"), image("absolutePath", "/c.png", true)];
    expect(await resolveImagePathsForInsert(batch, host())).toEqual(["assets/a.png", "https://x/b.png", "assets/c.png"]);
    expect(await resolveImagePathsForInsert([], host())).toEqual([]);

    copyImage.mockClear();
    copyImage.mockRejectedValueOnce(new Error("disk full"));
    expect(await resolveImagePathsForInsert(batch, host())).toBeNull();
    expect(copyImage).toHaveBeenCalledTimes(1);
  });
});

describe("offerImagePaste", () => {
  const fallbackNotice = () => i18n.t("dialog:toast.imagePathFallbackPasted");

  it("offers paths that need no check synchronously, inside the paste event", () => {
    const target = createTarget();
    offerImagePaste(target, [image("url", "https://example.com/a.png")]);

    expect(toasts).toEqual([
      expect.objectContaining({
        imagePath: "https://example.com/a.png",
        imageType: "url",
        anchorRect: { top: 1, left: 2, bottom: 3, right: 4 },
        editorDom: target.editorDom,
      }),
    ]);
    expect(exists).not.toHaveBeenCalled();
  });

  it("offers one existing local image as a single-image toast", async () => {
    offerImagePaste(createTarget(), [image("absolutePath", "/a.png", true)]);
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatchObject({ imagePath: "/a.png", imageType: "localPath" });
    expect(toasts[0].imageResults).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });

  it("offers several images as one batch toast", async () => {
    const batch = [image("absolutePath", "/a.png", true), image("url", "https://x/b.png")];
    offerImagePaste(createTarget(), batch);
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0].imageResults).toEqual(batch);
    expect(toasts[0].imagePath).toBeUndefined();
  });

  it.each([
    ["a missing single path", [image("absolutePath", "/missing.png", true)]],
    ["a batch with one missing path", [image("url", "https://x/a.png"), image("absolutePath", "/missing.png", true)]],
  ])("pastes the text and says so for %s", async (_label, results) => {
    vi.mocked(exists).mockResolvedValue(false);
    const target = createTarget();
    offerImagePaste(target, results);

    await vi.waitFor(() => expect(target.pasteAsText).toHaveBeenCalledTimes(1));
    expect(info.mock.calls).toEqual([[fallbackNotice()]]);
    expect(toasts).toEqual([]);
  });

  it("does nothing at all when the view went away during the check", async () => {
    for (const present of [true, false]) {
      vi.mocked(exists).mockResolvedValue(present);
      const target = createTarget();
      target.isConnected.mockReturnValue(false);
      offerImagePaste(target, [image("absolutePath", "/a.png", true)]);
      await vi.waitFor(() => expect(target.isConnected).toHaveBeenCalled());

      expect(target.pasteAsText).not.toHaveBeenCalled();
    }
    expect(toasts).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it("pastes the text, without a notice, when the check itself blows up", async () => {
    const failure = new Error("anchor failed");
    const target = createTarget();
    target.anchorRect.mockImplementation(() => {
      throw failure;
    });
    offerImagePaste(target, [image("absolutePath", "/a.png", true)]);

    await vi.waitFor(() => expect(target.pasteAsText).toHaveBeenCalledTimes(1));
    expect(target.log.error).toHaveBeenCalledWith("Failed to validate image paths:", failure);
    expect(info).not.toHaveBeenCalled();
  });

  describe("the toast's answers", () => {
    const single = [image("url", "https://x/a.png")];
    const batch = [image("url", "https://x/a.png"), image("url", "https://x/b.png"), image("url", "https://x/c.png")];

    it("confirm inserts the single image, or the whole batch", () => {
      const target = createTarget();
      offerImagePaste(target, single);
      offerImagePaste(target, batch);
      toasts[0].onConfirm();
      toasts[1].onConfirm();

      expect(target.insertSingle.mock.calls).toEqual([[single[0]]]);
      expect(target.insertMultiple.mock.calls).toEqual([[batch]]);
      expect(error).not.toHaveBeenCalled();
    });

    it("a failed insertion is logged and reported, with the count for a batch", async () => {
      const failure = new Error("dispatch failed");
      const target = createTarget();
      target.insertSingle.mockRejectedValue(failure);
      target.insertMultiple.mockRejectedValue(failure);
      offerImagePaste(target, single);
      offerImagePaste(target, batch);
      toasts[0].onConfirm();
      toasts[1].onConfirm();

      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
      expect(error.mock.calls).toEqual([
        [i18n.t("dialog:toast.failedToInsertImage")],
        [i18n.t("dialog:toast.failedToInsertImages", { count: 3 })],
      ]);
      expect(target.log.error.mock.calls).toEqual([
        ["Failed to insert image:", failure],
        ["Failed to insert images:", failure],
      ]);
    });

    it("dismiss pastes the original text", () => {
      const target = createTarget();
      offerImagePaste(target, single);
      toasts[0].onDismiss?.();
      expect(target.pasteAsText).toHaveBeenCalledTimes(1);
    });

    it("neither answer touches a view that has since gone away", () => {
      const target = createTarget();
      offerImagePaste(target, single);
      target.isConnected.mockReturnValue(false);

      toasts[0].onConfirm();
      toasts[0].onDismiss?.();

      expect(target.insertSingle).not.toHaveBeenCalled();
      expect(target.pasteAsText).not.toHaveBeenCalled();
      expect(target.log.warn).toHaveBeenCalledWith("View disconnected, cannot insert image");
    });
  });
});
