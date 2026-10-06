/**
 * Purpose: the "could not reveal" message that matches the reveal action's
 * label — Finder on macOS, Explorer on Windows, the file manager elsewhere.
 *
 * The platform is decided ONCE, by `revealInFileManagerKey`; this only maps
 * each label to its failure message, and the exhaustive record makes a new
 * label without a message a type error.
 *
 * @coordinates-with pathUtils.ts — revealInFileManagerKey, the platform rule
 * @module utils/revealFailedKey
 */
import { revealInFileManagerKey, type RevealInFileManagerKey } from "./pathUtils";

/** Translation key of a "could not reveal" message, namespace included. */
export type RevealFailedKey =
  | "dialog:toast.revealFailedFinder"
  | "dialog:toast.revealFailedExplorer"
  | "dialog:toast.revealFailedFileManager";

const FAILURE_FOR_LABEL: Readonly<Record<RevealInFileManagerKey, RevealFailedKey>> = {
  "sidebar:contextMenu.revealInFinder": "dialog:toast.revealFailedFinder",
  "sidebar:contextMenu.showInExplorer": "dialog:toast.revealFailedExplorer",
  "sidebar:contextMenu.showInFileManager": "dialog:toast.revealFailedFileManager",
};

/** Platform-appropriate translation key for a failed reveal; callers translate it. */
export function revealFailedKey(): RevealFailedKey {
  return FAILURE_FOR_LABEL[revealInFileManagerKey()];
}
