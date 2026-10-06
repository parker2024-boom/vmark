/**
 * Underline mark — the Tiptap extension that parses and renders underlined
 * text as `<u>`.
 *
 * @module plugins/underline/tiptap
 */

import { Mark, mergeAttributes } from "@tiptap/core";
import "./underline.css";

/** Tiptap mark extension for underlined text (renders as `<u>`). */
export const underlineExtension = Mark.create({
  name: "underline",
  parseHTML() {
    return [{ tag: "u" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["u", mergeAttributes(HTMLAttributes, { class: "md-underline" }), 0];
  },
});
