/**
 * Subscript and superscript marks — the Tiptap extensions that parse and
 * render `<sub>` and `<sup>` text.
 *
 * @module plugins/subSuperscript/tiptap
 */

import { Mark, mergeAttributes } from "@tiptap/core";
import "./sub-super.css";

/** Tiptap mark extension for subscript text (renders as `<sub>`). */
export const subscriptExtension = Mark.create({
  name: "subscript",
  parseHTML() {
    return [{ tag: "sub" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(HTMLAttributes, { class: "md-subscript" }), 0];
  },
});

/** Tiptap mark extension for superscript text (renders as `<sup>`). */
export const superscriptExtension = Mark.create({
  name: "superscript",
  parseHTML() {
    return [{ tag: "sup" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes, { class: "md-superscript" }), 0];
  },
});

