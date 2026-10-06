/**
 * Save-on-Close Shared Surface (leaf)
 *
 * Purpose: the types, translated button labels and filename/filter helpers shared by
 * closeSave.ts (the prompts) and closeSaveBatch.ts (the batch persistence).
 * A leaf so neither of those imports the other — the two-file split otherwise
 * forms a cycle.
 *
 * @coordinates-with closeSave.ts — prompts
 * @coordinates-with closeSaveBatch.ts — batch persistence
 * @module services/windowClose/closeSaveShared
 */

import i18n from "@/i18n";

/** Context describing a dirty document that may need saving before close. */
export interface CloseSaveContext {
  windowLabel: string;
  tabId: string;
  title: string;
  filePath: string | null;
  content: string;
  /** DIVERGENT rather than dirty: the user kept local content after an
   *  external edit — the prompt says the file changed on disk. */
  divergent?: boolean;
}

/** Result of a single-document save prompt: saved (with path), discarded, or cancelled. */
export type CloseSaveResult =
  | { action: "saved"; path: string }
  | { action: "discarded" }
  | { action: "cancelled" };

/** Result of a multi-document save prompt: all saved, all discarded, or cancelled. */
export type MultiSaveResult =
  | { action: "saved-all" }
  | { action: "discarded-all" }
  | { action: "cancelled" };

/** Options for multi-document save operations. */
export interface MultiSaveOptions {
  /** Called before saving each document, 1-indexed */
  onProgress?: (current: number, total: number, title: string) => void;
  /**
   * Called immediately before each write, after any dialog has closed. Returns
   * the context to write — the document as it is NOW — or `null` when it no
   * longer needs saving (its tab closed, or another path saved it while a
   * dialog was open). A context is a capture, and a dialog stays open for as
   * long as the user takes. Absent: the captured context is written as-is, for
   * callers that revalidate after the batch instead.
   */
  revalidate?: (context: CloseSaveContext) => CloseSaveContext | null;
}

/**
 * Button labels for the single-document save prompt, translated per call.
 * The dialog reports a click by returning the clicked label, so the caller
 * must compare against the SAME object it showed (`closeSave.i18n.test.ts`
 * checks every locale keeps the three labels distinct).
 */
export function closeSaveButtons(): { save: string; dontSave: string; cancel: string } {
  return {
    save: i18n.t("dialog:unsavedChanges.buttonSave"),
    dontSave: i18n.t("dialog:unsavedChanges.buttonDontSave"),
    cancel: i18n.t("dialog:unsavedChanges.buttonCancel"),
  };
}

/** Button labels for the multi-document save prompt; see `closeSaveButtons`. */
export function multiSaveButtons(): { saveAll: string; dontSave: string; cancel: string } {
  return {
    saveAll: i18n.t("dialog:unsavedChanges.buttonSaveAll"),
    dontSave: i18n.t("dialog:unsavedChanges.buttonDontSave"),
    cancel: i18n.t("dialog:unsavedChanges.buttonCancel"),
  };
}

// Derive Save dialog filters per-tab from the format registry.
// Untitled tabs default to markdown (the canonical "Save As" flow). Filter
// NAMES resolve through i18n at dialog time: the adapter carries a key, not a
// literal, so the name is not frozen in English at module-load time. The
// pre-bootstrap fallback is the SHARED markdownSaveFilters() — the local copy
// it replaces listed only `.md`, hiding `.mdx` files here but not in the open
// dialog.
import { dispatchEditor, getFormatById } from "@/lib/formats/registry";
import { resolveSaveFilters, markdownSaveFilters } from "@/lib/formats/saveFilters";

export function saveFiltersForFilePath(
  filePath: string | null,
): { name: string; extensions: string[] }[] {
  try {
    const cfg = filePath
      ? dispatchEditor(filePath)
      : (getFormatById("markdown") ?? dispatchEditor(null));
    return resolveSaveFilters(cfg);
  } catch {
    /* registry not bootstrapped (test edge) — one shared markdown fallback */
    return markdownSaveFilters();
  }
}

function untitledExtensionForFilePath(filePath: string | null): string {
  try {
    const cfg = filePath
      ? dispatchEditor(filePath)
      : (getFormatById("markdown") ?? dispatchEditor(null));
    return cfg.adapters.untitledExtension;
  } catch {
    /* registry not bootstrapped — preserve prior `.md` default */
    return "md";
  }
}


/** Replace characters invalid on Windows/macOS/Linux (/ \ : * ? " < > |) and collapse whitespace. */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

/**
 * Sanitize a title for use as a filename. A title with nothing usable in it
 * falls back to the translated untitled name new tabs get (common:untitled),
 * sanitized the same way.
 */
export function toSafeFilename(title: string): string {
  return sanitizeFilename(title) || sanitizeFilename(i18n.t("common:untitled"));
}

/**
 * Ensure filename ends with the default extension for `filePath`'s format.
 * Untitled tabs default to markdown (.md). This used to be
 * hardcoded ".md".
 */
export function ensureFormatExtension(
  filename: string,
  filePath: string | null,
): string {
  const ext = untitledExtensionForFilePath(filePath);
  const dotted = `.${ext}`;
  return filename.endsWith(dotted) ? filename : `${filename}${dotted}`;
}
