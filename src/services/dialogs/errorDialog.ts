/**
 * User-facing error dialog utility
 *
 * Provides consistent error messaging for file operations.
 *
 * @module services/dialogs/errorDialog
 */

import { message } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";

/**
 * Show an error dialog to the user.
 * Use for file operation failures that the user needs to know about.
 */
export async function showError(
  title: string,
  description?: string
): Promise<void> {
  const text = description ? `${title}\n\n${description}` : title;
  await message(text, {
    title: i18n.t("dialog:error.title"),
    kind: "error",
  });
}

/**
 * Common error messages for file operations, translated when called — never
 * at import, so a language change is honoured. `copyFailed` is a getter for
 * the same reason.
 */
export const FileErrors = {
  fileExists: (name: string) => i18n.t("dialog:fileError.fileExists", { name }),
  folderExists: (name: string) => i18n.t("dialog:fileError.folderExists", { name }),
  createFailed: (name: string) => i18n.t("dialog:fileError.createFailed", { name }),
  renameFailed: (name: string) => i18n.t("dialog:fileError.renameFailed", { name }),
  deleteFailed: (name: string) => i18n.t("dialog:fileError.deleteFailed", { name }),
  moveFailed: (name: string) => i18n.t("dialog:fileError.moveFailed", { name }),
  duplicateFailed: (name: string) => i18n.t("dialog:fileError.duplicateFailed", { name }),
  get copyFailed(): string {
    return i18n.t("dialog:fileError.copyFailed");
  },
  exportFailed: (format: string) => i18n.t("dialog:fileError.exportFailed", { format }),
  tooManyCopies: (name: string) => i18n.t("dialog:fileError.tooManyCopies", { name }),
};
