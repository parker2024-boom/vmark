/**
 * Inline Code Boundary Extension for Tiptap
 *
 * Wraps the ProseMirror plugin that fixes cursor behavior at the
 * left boundary of inline code marks.
 *
 * @module plugins/inlineCodeBoundary/tiptap
 */

import { Extension } from "@tiptap/core";
import { createInlineCodeBoundaryPlugin } from "./plugin";

/** Tiptap extension that improves cursor behavior at inline code mark boundaries. */
export const inlineCodeBoundaryExtension = Extension.create({
  name: "inlineCodeBoundary",

  addProseMirrorPlugins() {
    return [createInlineCodeBoundaryPlugin()];
  },
});
