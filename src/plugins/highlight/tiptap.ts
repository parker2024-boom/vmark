/**
 * Highlight mark — the Tiptap extension that parses and renders highlighted
 * text as `<mark>`.
 *
 * @module plugins/highlight/tiptap
 */

import { Mark, mergeAttributes } from "@tiptap/core";
import "./highlight.css";

/** Tiptap mark extension for text highlighting (renders as `<mark>`). */
export const highlightExtension = Mark.create({
  name: "highlight",
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes, { class: "md-highlight" }), 0];
  },
});

