/**
 * Multi-cursor Tiptap extension
 *
 * Integrates the multi-cursor plugin and keymap with Tiptap.
 * Provides VSCode/Sublime-style multi-cursor editing.
 *
 * @module plugins/multiCursor/tiptap
 */

import { Extension } from "@tiptap/core";
import { multiCursorPlugin } from "./multiCursorPlugin";
import { multiCursorKeymap } from "./keymap";

// Import CSS for styling
import "./multi-cursor.css";

/** Configuration options for the multi-cursor extension. */
export interface MultiCursorOptions {
  /** Enable keyboard shortcuts (default: true) */
  enableKeymap: boolean;
}

/**
 * Multi-cursor extension for Tiptap.
 *
 * Features:
 * - Multiple cursor positions and selections
 * - Cmd+D: Select next occurrence
 * - Cmd+Shift+L: Select all occurrences
 * - Escape: Collapse to single cursor
 *
 * @example
 * ```ts
 * import { multiCursorExtension } from "@/plugins/multiCursor/tiptap";
 *
 * const editor = useEditor({
 *   extensions: [
 *     // ...other extensions
 *     multiCursorExtension,
 *   ],
 * });
 * ```
 */
export const multiCursorExtension = Extension.create<MultiCursorOptions>({
  name: "multiCursor",

  addOptions() {
    return {
      enableKeymap: true,
    };
  },

  addProseMirrorPlugins() {
    const plugins = [multiCursorPlugin()];

    /* v8 ignore next -- @preserve enableKeymap=false is never used in production config */
    if (this.options.enableKeymap) {
      plugins.push(multiCursorKeymap());
    }

    return plugins;
  },
});
