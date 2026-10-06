/**
 * Image Paste Resolution
 *
 * Purpose: The one flow for pasted image paths, shared by WYSIWYG and Source:
 * check the paths, offer the image through the host's confirmation toast, fall
 * back to pasting the text, and tell the user about every fallback and failure.
 *
 * Pipeline: detected paths -> allImagePathsExist -> hostPopups toast
 *   -> (confirm) target.insert* -> resolveImagePathForInsert
 *   -> (dismiss / invalid) target.pasteAsText + hostNotify
 *
 * Key decisions:
 *   - The editor is a parameter (`ImagePasteTarget`): each mode supplies how to
 *     paste text and insert an image, and nothing else. Every user-visible
 *     decision — what is validated, when a notice is shown, which message —
 *     lives here, so the two modes cannot drift apart.
 *   - Paths that need no filesystem check (URLs, data URLs, relative paths)
 *     are offered synchronously, inside the paste event.
 *   - A view that went away while a check was running gets nothing: no text,
 *     no toast, no notice.
 *   - Copying into the assets folder is the host's operation and the user's
 *     setting; both arrive as `ImageInsertHost` so this module stays inside
 *     the plugin boundary.
 *
 * @coordinates-with plugins/shared/localImagePath.ts — home expansion and existence checks
 * @coordinates-with plugins/shared/hostPopups.ts — the confirmation toast
 * @coordinates-with plugins/shared/hostNotify.ts — fallback and failure notices
 * @coordinates-with plugins/imageHandler/imageHandlerToast.ts — the WYSIWYG target
 * @coordinates-with plugins/codemirror/smartPasteImage.ts — the Source target
 * @module plugins/shared/imagePasteResolve
 */

import { message } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";
import type { ImagePathResult } from "@/utils/imagePathDetection";
import { hostNotify } from "./hostNotify";
import { hostPopups } from "./hostPopups";
import { expandHomePath, validateLocalPath } from "./localImagePath";

type AnchorRect = { top: number; left: number; bottom: number; right: number };

/** Whether an editor view (either mode) is still attached to the document. */
export function isViewConnected(
  view: { dom?: { isConnected?: boolean } | null } | null | undefined
): boolean {
  if (!view) return false;
  try {
    return view.dom?.isConnected ?? false;
  } catch {
    return false;
  }
}

/** Only absolute and home paths can be checked; a relative path has no base here. */
function needsFilesystemCheck(result: ImagePathResult): boolean {
  return result.type === "absolutePath" || result.type === "homePath";
}

/**
 * Whether every checkable path points at an existing file. URLs, data URLs and
 * relative paths count as present. Checks run in parallel.
 */
export async function allImagePathsExist(results: ImagePathResult[]): Promise<boolean> {
  const checks = results.filter(needsFilesystemCheck).map(async (result) => {
    const path = result.type === "homePath" ? await expandHomePath(result.path) : result.path;
    return path !== null && (await validateLocalPath(path));
  });
  return (await Promise.all(checks)).every(Boolean);
}

/** What resolving an image for insertion needs from the host. */
export interface ImageInsertHost {
  /** The document's path, or null when it has never been saved. */
  documentPath: string | null;
  /** The user's "copy to assets folder" setting. */
  copyToAssets: boolean;
  /** Copy a file next to the document; resolves to the path to write into it. */
  copyImage: (sourcePath: string, documentPath: string) => Promise<string>;
  logError: (message: string, error: unknown) => void;
}

/**
 * The path to write into the document for one confirmed image: the copied
 * asset when copying is on, otherwise the image's own (home-expanded) path.
 * Returns null after telling the user why, when the image cannot be inserted.
 */
export async function resolveImagePathForInsert(
  detection: ImagePathResult,
  host: ImageInsertHost
): Promise<string | null> {
  if (!detection.needsCopy) return detection.path;

  // Copying needs a saved document to copy next to; linking in place does not.
  const copyNextTo = host.copyToAssets ? host.documentPath : null;
  if (host.copyToAssets && !copyNextTo) {
    await message(i18n.t("dialog:unsavedDocument.messageInsertImagesLocal"), {
      title: i18n.t("dialog:unsavedDocument.title"),
      kind: "warning",
    });
    return null;
  }

  const sourcePath =
    detection.type === "homePath" ? await expandHomePath(detection.path) : detection.path;
  if (!sourcePath) {
    await message(i18n.t("dialog:toast.failedToResolveHomePath"), { kind: "error" });
    return null;
  }
  if (!copyNextTo) return sourcePath;

  try {
    return await host.copyImage(sourcePath, copyNextTo);
  } catch (error) {
    host.logError("Failed to copy image to assets:", error);
    await message(i18n.t("dialog:toast.failedToCopyToAssets"), { kind: "error" });
    return null;
  }
}

/** Resolve a batch in order; null as soon as one image cannot be inserted. */
export async function resolveImagePathsForInsert(
  results: ImagePathResult[],
  host: ImageInsertHost
): Promise<string[] | null> {
  const paths: string[] = [];
  for (const detection of results) {
    const resolved = await resolveImagePathForInsert(detection, host);
    if (resolved === null) return null;
    paths.push(resolved);
  }
  return paths;
}

/** The editor a pasted image path is being offered to. */
export interface ImagePasteTarget {
  /** The editor's root element; the confirmation toast is anchored inside it. */
  editorDom: HTMLElement;
  isConnected: () => boolean;
  /** Where to anchor the confirmation toast, in viewport coordinates. */
  anchorRect: () => AnchorRect;
  /** Insert the pasted text verbatim (the fallback, and the toast's dismiss). */
  pasteAsText: () => void;
  insertSingle: (detection: ImagePathResult) => Promise<void>;
  insertMultiple: (results: ImagePathResult[]) => Promise<void>;
  log: {
    warn: (message: string) => void;
    error: (message: string, error: unknown) => void;
  };
}

function showConfirmation(target: ImagePasteTarget, results: ImagePathResult[]): void {
  const single = results.length === 1 ? results[0] : null;
  const noun = single ? "image" : "images";

  const onConfirm = (): void => {
    if (!target.isConnected()) {
      target.log.warn(`View disconnected, cannot insert ${noun}`);
      return;
    }
    const inserting = single ? target.insertSingle(single) : target.insertMultiple(results);
    inserting.catch((error: unknown) => {
      target.log.error(`Failed to insert ${noun}:`, error);
      hostNotify.error(
        single
          ? i18n.t("dialog:toast.failedToInsertImage")
          : i18n.t("dialog:toast.failedToInsertImages", { count: results.length })
      );
    });
  };
  const onDismiss = (): void => {
    if (target.isConnected()) target.pasteAsText();
  };
  const base = { anchorRect: target.anchorRect(), editorDom: target.editorDom, onConfirm, onDismiss };

  if (single) {
    const isUrl = single.type === "url" || single.type === "dataUrl";
    hostPopups.showImagePasteToast({
      ...base,
      imagePath: single.path,
      imageType: isUrl ? "url" : "localPath",
    });
  } else {
    hostPopups.showImagePasteToast({ ...base, imageResults: results });
  }
}

async function checkThenOffer(target: ImagePasteTarget, results: ImagePathResult[]): Promise<void> {
  const allExist = await allImagePathsExist(results);
  if (!target.isConnected()) return;

  if (!allExist) {
    target.pasteAsText();
    hostNotify.info(i18n.t("dialog:toast.imagePathFallbackPasted"));
    return;
  }
  showConfirmation(target, results);
}

/**
 * Offer the pasted image path(s) to the user. Paths that exist (or cannot be
 * checked) get the confirmation toast; a missing path, or a failed check,
 * pastes the original text instead. `results` must be non-empty.
 */
export function offerImagePaste(target: ImagePasteTarget, results: ImagePathResult[]): void {
  if (!results.some(needsFilesystemCheck)) {
    showConfirmation(target, results);
    return;
  }

  checkThenOffer(target, results).catch((error: unknown) => {
    target.log.error("Failed to validate image paths:", error);
    if (target.isConnected()) target.pasteAsText();
  });
}
