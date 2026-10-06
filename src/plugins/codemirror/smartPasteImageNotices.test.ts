// WI-RA9A.2 — Source image paste tells the user what it did, as WYSIWYG does.
/**
 * Source-mode image paste used to fall back to plain text, and fail an
 * insertion, without a word. These tests drive `tryImagePaste` against a real
 * CodeMirror view and the real host seams, faking only what leaves the
 * process: the Tauri filesystem, path and dialog APIs, and the asset copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsExists = vi.fn<(path: string) => Promise<boolean>>();
const homeDir = vi.fn<() => Promise<string>>();
const dialogMessage = vi.fn<(text: string, options?: unknown) => Promise<void>>();
const copyImageToAssets = vi.fn<(source: string, documentPath: string) => Promise<string>>();

vi.mock("@tauri-apps/plugin-fs", () => ({ exists: (path: string) => fsExists(path) }));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: () => homeDir(),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (text: string, options?: unknown) => dialogMessage(text, options),
}));
vi.mock("@/services/media/imageOperations", () => ({
  copyImageToAssets: (source: string, documentPath: string) => copyImageToAssets(source, documentPath),
}));
vi.mock("@/services/navigation/windowFocus", () => ({ getWindowLabel: () => "main" }));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import i18n from "@/i18n";
import { bindHostDocument, resetHostDocument } from "@/plugins/shared/hostDocument";
import { bindHostNotify, resetHostNotify } from "@/plugins/shared/hostNotify";
import { bindHostPopups, resetHostPopups } from "@/plugins/shared/hostPopups";
import { bindHostSettings, resetHostSettings } from "@/plugins/shared/hostSettings";
import { tryImagePaste } from "./smartPasteImage";

type ToastRequest = Parameters<NonNullable<Parameters<typeof bindHostPopups>[0]["showImagePasteToast"]>>[0];

const info = vi.fn<(message: string) => void>();
const error = vi.fn<(message: string) => void>();
const toasts: ToastRequest[] = [];
const views: EditorView[] = [];

function createView(doc = ""): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc }), parent });
  views.push(view);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.length = 0;
  fsExists.mockResolvedValue(true);
  homeDir.mockResolvedValue("/Users/test");
  dialogMessage.mockResolvedValue(undefined);
  copyImageToAssets.mockResolvedValue("assets/copied.png");
  bindHostNotify({ info, error });
  bindHostPopups({ showImagePasteToast: (request) => toasts.push(request) });
  bindHostDocument({ activeFilePath: () => "/docs/note.md" });
  bindHostSettings({ copyImagesToAssets: () => true });
});

afterEach(() => {
  views.forEach((view) => view.destroy());
  views.length = 0;
  resetHostNotify();
  resetHostPopups();
  resetHostDocument();
  resetHostSettings();
});

const fallbackNotice = () => i18n.t("dialog:toast.imagePathFallbackPasted");

describe("Source image paste — fallback notice", () => {
  it("says so when a pasted image path does not exist and it pastes the text instead", async () => {
    fsExists.mockResolvedValue(false);
    const view = createView();

    expect(tryImagePaste(view, "/missing/图片.png")).toBe(true);

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("/missing/图片.png"));
    expect(info.mock.calls).toEqual([[fallbackNotice()]]);
    expect(toasts).toEqual([]);
  });

  it("says so when the home directory cannot be resolved", async () => {
    homeDir.mockRejectedValue(new Error("no home"));
    const view = createView();

    tryImagePaste(view, "~/shot.png");

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("~/shot.png"));
    expect(info.mock.calls).toEqual([[fallbackNotice()]]);
  });

  it("says so once when any path of a multi-image paste is missing", async () => {
    fsExists.mockImplementation((path) => Promise.resolve(path !== "/b.png"));
    const view = createView();
    const pasted = "/a.png\n/b.png\n/c.png";

    tryImagePaste(view, pasted);

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(pasted));
    expect(info.mock.calls).toEqual([[fallbackNotice()]]);
    expect(toasts).toEqual([]);
  });

  it("stays quiet when the editor went away while the path was being checked", async () => {
    let finish: (exists: boolean) => void = () => {};
    fsExists.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
    const view = createView();

    tryImagePaste(view, "/gone.png");
    view.dom.parentElement?.remove();
    finish(false);
    await vi.waitFor(() => expect(fsExists).toHaveBeenCalled());
    await Promise.resolve();

    expect(info).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");
  });

  it("offers the image, without a notice, when the path exists", async () => {
    const view = createView();

    tryImagePaste(view, "/ok.png");

    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("Source image paste — insertion failure notice", () => {
  it("reports a failed single-image insertion after the user confirmed it", async () => {
    const view = createView();
    tryImagePaste(view, "/ok.png");
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    view.dispatch = () => {
      throw new Error("dispatch failed");
    };

    toasts[0].onConfirm();

    await vi.waitFor(() =>
      expect(error.mock.calls).toEqual([[i18n.t("dialog:toast.failedToInsertImage")]])
    );
  });

  it("reports a failed multi-image insertion with the image count", async () => {
    const view = createView();
    tryImagePaste(view, "/a.png\n/b.png");
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    view.dispatch = () => {
      throw new Error("dispatch failed");
    };

    toasts[0].onConfirm();

    await vi.waitFor(() =>
      expect(error.mock.calls).toEqual([[i18n.t("dialog:toast.failedToInsertImages", { count: 2 })]])
    );
  });
});

describe("Source image paste — the copy-to-assets setting", () => {
  it("copies a confirmed local image into the assets folder while the setting is on", async () => {
    const view = createView();
    tryImagePaste(view, "/pics/a.png");
    await vi.waitFor(() => expect(toasts).toHaveLength(1));

    toasts[0].onConfirm();

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](assets/copied.png)"));
    expect(copyImageToAssets).toHaveBeenCalledWith("/pics/a.png", "/docs/note.md");
  });

  it("links the image in place, without copying, while the setting is off", async () => {
    bindHostSettings({ copyImagesToAssets: () => false });
    const view = createView();
    tryImagePaste(view, "~/pics/a.png");
    await vi.waitFor(() => expect(toasts).toHaveLength(1));

    toasts[0].onConfirm();

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](/Users/test/pics/a.png)"));
    expect(copyImageToAssets).not.toHaveBeenCalled();
    expect(dialogMessage).not.toHaveBeenCalled();
  });

  it("links every image of a batch in place while the setting is off, even in an unsaved document", async () => {
    bindHostSettings({ copyImagesToAssets: () => false });
    bindHostDocument({ activeFilePath: () => null });
    const view = createView();
    tryImagePaste(view, "/a.png\n/b.png");
    await vi.waitFor(() => expect(toasts).toHaveLength(1));

    toasts[0].onConfirm();

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](/a.png)\n![](/b.png)"));
    expect(copyImageToAssets).not.toHaveBeenCalled();
    expect(dialogMessage).not.toHaveBeenCalled();
  });
});
