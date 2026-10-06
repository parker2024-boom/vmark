/**
 * HTML Sanitization Utilities
 *
 * Purpose: Secure HTML sanitization via DOMPurify to prevent XSS attacks. Tailored
 * allowlists per content type — general HTML, SVG, KaTeX.
 *
 * Key decisions:
 *   - Separate functions for each content type (general HTML, SVG, KaTeX) because
 *     each has different security requirements and allowed elements
 *   - SVG sanitization allows foreignObject + HTML profiles for Mermaid diagrams
 *     (Mermaid uses HTML inside SVG for text layout)
 *   - Style attribute sanitization uses a property allowlist to block
 *     expression() and javascript: attacks in inline styles
 *   - DOMPurify's output is re-parsed (the style filter) only in an inert
 *     document: the page's own document would load what it parses
 *   - escapeHtml is a simple entity escape for non-HTML text display
 *   - Preview allow-lists (strict/extended) + the always-on `DANGEROUS_TAGS`
 *     deny-list live in `utils/htmlAllowlists.ts`; `FORBID_TAGS` overrides
 *     `ALLOWED_TAGS`, so user-supplied custom tags can never allow <script> etc.
 *
 * @coordinates-with htmlAllowlists.ts — preview allow/deny tag + attr lists
 * @coordinates-with mermaid/index.ts — uses sanitizeSvg for Mermaid diagram output
 * @coordinates-with codePreview/renderers/renderLatex.ts — uses sanitizeKatex for math rendering
 * @module utils/sanitize
 */

import DOMPurify from "dompurify";
export { sanitizeSvg } from "./svgSanitize";
import { KATEX_STYLE_PROPS, filterStyleAttributes } from "./styleSafety";
import {
  type HtmlAllowlistLevel,
  PREVIEW_TAGS_INLINE_STRICT,
  PREVIEW_TAGS_BLOCK_STRICT,
  PREVIEW_TAGS_INLINE_EXTENDED,
  PREVIEW_TAGS_BLOCK_EXTENDED,
  PREVIEW_ATTRS_STRICT,
  PREVIEW_ATTRS_EXTENDED,
  PREVIEW_STYLE_PROPS as HTML_PREVIEW_STYLE_PROPS,
  DANGEROUS_TAGS,
} from "./htmlAllowlists";

/** Whether the HTML preview allows inline-only or block-level elements. */
type HtmlPreviewContext = "inline" | "block";

/** Options for sanitizeHtmlPreview: context level, style allowlist, and tag breadth. */
export interface HtmlPreviewOptions {
  allowStyles?: boolean;
  context?: HtmlPreviewContext;
  /** Allow-list breadth: "strict" (default) or "extended" (svg, figure, details, …). */
  allowlistLevel?: HtmlAllowlistLevel;
  /** Extra tag names to allow on top of the level (already parsed/validated). */
  customTags?: string[];
}

/** Sanitize HTML for preview display with configurable context, styles, and allow-list breadth. */
export function sanitizeHtmlPreview(html: string, options?: HtmlPreviewOptions): string {
  const context = options?.context ?? "inline";
  const allowStyles = options?.allowStyles ?? false;
  const extended = options?.allowlistLevel === "extended";

  const baseInline = extended ? PREVIEW_TAGS_INLINE_EXTENDED : PREVIEW_TAGS_INLINE_STRICT;
  const baseBlock = extended ? PREVIEW_TAGS_BLOCK_EXTENDED : PREVIEW_TAGS_BLOCK_STRICT;
  const baseTags = context === "block" ? baseBlock : baseInline;
  // Custom tags ride on top, but DANGEROUS_TAGS (FORBID_TAGS) always wins.
  const allowedTags = options?.customTags?.length
    ? [...baseTags, ...options.customTags]
    : baseTags;

  const baseAttrs = extended ? PREVIEW_ATTRS_EXTENDED : PREVIEW_ATTRS_STRICT;
  const allowedAttrs = allowStyles ? [...baseAttrs, "style"] : baseAttrs;

  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttrs,
    FORBID_TAGS: DANGEROUS_TAGS,
    ALLOW_DATA_ATTR: false,
  });

  if (!allowStyles) {
    return sanitized;
  }

  return filterStyleAttributes(sanitized, HTML_PREVIEW_STYLE_PROPS);
}

/**
 * Sanitize KaTeX output for safe rendering.
 */
export function sanitizeKatex(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "span",
      "math",
      "semantics",
      "mrow",
      "mi",
      "mo",
      "mn",
      "msup",
      "msub",
      "mfrac",
      "mover",
      "munder",
      "munderover",
      "msqrt",
      "mroot",
      "mtable",
      "mtr",
      "mtd",
      "mtext",
      "mspace",
      "annotation",
      "svg",
      "line",
      "path",
    ],
    ALLOWED_ATTR: [
      "class",
      "style",
      "mathvariant",
      "displaystyle",
      "scriptlevel",
      "width",
      "height",
      "viewBox",
      "preserveAspectRatio",
      "xmlns",
      "d",
      "x1",
      "y1",
      "x2",
      "y2",
      "stroke",
      "stroke-width",
    ],
    ALLOW_DATA_ATTR: false,
  });
  // KaTeX needs inline styles for layout, but an unfiltered `style` is a
  // beacon (`url(https://…)`) and a viewport overlay (`position: fixed`).
  // Filter to the properties KaTeX actually emits, with safe values.
  return filterStyleAttributes(sanitized, KATEX_STYLE_PROPS);
}

/**
 * Escape HTML entities for safe text display.
 * Use when displaying raw content in error messages.
 */
export function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  /* v8 ignore next -- @preserve regex only matches chars that are keys in htmlEscapes */
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char] || char);
}
