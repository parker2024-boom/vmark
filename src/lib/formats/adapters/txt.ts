/**
 * Plain text adapter — the simplest format and the end-to-end pipeline smoke test.
 *
 * Plain `.txt` is the simplest non-markdown format and the dispatcher
 * fallback for unknown extensions. No language pack, no validator, no
 * preview — just the SplitPaneEditor source pane with native CodeMirror
 * editing, find, undo, save.
 *
 * @module lib/formats/adapters/txt
 */

import { registerFormat } from "../registry";
import type { FormatConfig } from "../types";

export const txtFormat: FormatConfig = {
  id: "txt",
  nameI18nKey: "format.txt",
  extensions: ["txt"],
  kind: "split-pane",
  adapters: {
    saveDialogFilters: [{ nameI18nKey: "format.txt", extensions: ["txt"] }],
    untitledExtension: "txt",
    exportEnabled: false,
    findEnabled: true,
    contentSearchIndexed: true,
    readOnlyDefault: false,
    reloadPolicy: "reload",
    menuPolicy: {
      sourceWysiwygToggle: false,
      cjkFormatActions: false,
      insertBlockActions: false,
      paragraphFormatting: false,
    },
    closeSavePolicy: "prompt-on-close",
  },
};

export function registerTxtFormat(): void {
  registerFormat(txtFormat);
}
