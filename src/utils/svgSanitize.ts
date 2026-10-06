/**
 * SVG sanitization.
 *
 * Purpose: make an untrusted SVG safe to render inside the app's own page —
 * strip scripting and forms, stop the document fetching anything when it is
 * merely opened, and confine its stylesheets to itself. Split out of
 * `sanitize.ts` so each file stays within its size budget and the SVG rules
 * sit next to the policy that decides them.
 *
 * Mermaid uses foreignObject with HTML labels (div, span) inside SVG.
 * HTML_INTEGRATION_POINTS tells DOMPurify to allow HTML inside foreignObject,
 * and the html profile provides the allowed HTML tag list. Without these,
 * DOMPurify strips the HTML wrappers from foreignObject content, losing the
 * inline styles mermaid relies on for text sizing.
 *
 * A `<style>` in the SVG is a stylesheet for the whole page. Each sanitize
 * call therefore marks its outermost `<svg>` with a scope attribute of its own
 * and rewrites every stylesheet to match only inside that root
 * (`svgStylesheetScope.ts`). The attribute is the sanitizer's alone: a copy
 * the document wrote is removed.
 *
 * @coordinates-with svgResourcePolicy.ts — which references may reach the network
 * @coordinates-with svgStylesheetScope.ts — confines stylesheets to the marked root
 * @coordinates-with sanitize.ts — re-exports sanitizeSvg for existing callers
 * @module utils/svgSanitize
 */

import DOMPurify from "dompurify";
import {
  isSameDocumentOrInlineRef,
  isResourceLoadingRef,
  hasExternalUrlReference,
  PAINT_URL_ATTRS,
} from "./svgResourcePolicy";
import { isSafeStyleAttribute } from "./styleSafety";
import { scopeStylesheet, SVG_STYLE_SCOPE_ATTR } from "./svgStylesheetScope";

/** Distinguishes one sanitize call's stylesheet scope from every other's. */
let scopeCounter = 0;

/** Whether `node` sits inside another `<svg>` — only the outermost is marked. */
function hasSvgAncestor(node: Node): boolean {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (parent.nodeName.toLowerCase() === "svg") return true;
  }
  return false;
}

/**
 * Sanitize SVG content for safe rendering (e.g., Mermaid diagrams).
 * Allows SVG elements but removes scripts and event handlers.
 * Preserves style attributes and all SVG-specific attributes for proper rendering.
 *
 * Mermaid uses foreignObject with HTML labels (div, span) inside SVG.
 * HTML_INTEGRATION_POINTS tells DOMPurify to allow HTML inside foreignObject,
 * and the html profile provides the allowed HTML tag list. Without these,
 * DOMPurify strips the HTML wrappers (div, span) from foreignObject content,
 * losing inline styles (line-height, display, text-align) that mermaid relies
 * on for correct text sizing — causing text to clip inside node boxes.
 */
export function sanitizeSvg(svg: string): string {
  // Use a separate DOMPurify instance for SVG to avoid hook leaks
  const purify = DOMPurify();
  // Only markup that can carry a stylesheet gets a scope, so an SVG without
  // one is returned exactly as before.
  const scopeKey = /<style/i.test(svg) ? (++scopeCounter).toString(36) : null;

  // A `<style>` element is a stylesheet for the whole PAGE, and it is where a
  // remote `@import` or an external `url()` hides — the attribute hook below
  // never sees it, because the payload is TEXT. Mermaid ships its theming
  // this way, so the sheet is confined and filtered rather than dropped.
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "style") return;
    const el = node as { textContent?: string | null };
    if (typeof el.textContent === "string" && el.textContent) {
      el.textContent = scopeKey ? scopeStylesheet(el.textContent, scopeKey) : "";
    }
  });

  // A stylesheet with nothing left once confined is removed, not left empty.
  purify.addHook("afterSanitizeElements", (node) => {
    if (node.nodeName.toLowerCase() === "style" && !node.textContent) {
      node.parentNode?.removeChild(node);
    }
  });

  // The scope lives on the outermost <svg>: every confined rule matches that
  // root and its descendants, and nothing else.
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (scopeKey && node.nodeName.toLowerCase() === "svg" && !hasSvgAncestor(node)) {
      (node as Element).setAttribute(SVG_STYLE_SCOPE_ATTR, scopeKey);
    }
  });

  purify.addHook("uponSanitizeAttribute", (node, data) => {
    const element = node?.nodeName ?? "";
    // The scope attribute is the sanitizer's to write. A copy in the document
    // would not widen anything, but a scope must mean "written here".
    if (data.attrName.toLowerCase() === SVG_STYLE_SCOPE_ATTR) {
      data.keepAttr = false;
      return;
    }
    if (data.attrName === "style" && data.attrValue) {
      // Shared predicate — a private copy here is how SVG and HTML preview
      // came to enforce different rules.
      if (!isSafeStyleAttribute(data.attrValue)) data.attrValue = "";
      // A style value fetches through url() exactly as an href does.
      if (hasExternalUrlReference(data.attrValue)) data.attrValue = "";
    }
    // A resource-loading reference must not reach the network: an untrusted
    // diagram would otherwise beacon the reader's IP and open time on open.
    // Element-aware by design — `<a href>` is navigation, not a fetch (see
    // svgResourcePolicy.ts).
    if (
      data.attrValue &&
      isResourceLoadingRef(element, data.attrName) &&
      !isSameDocumentOrInlineRef(data.attrValue)
    ) {
      data.attrValue = "";
      data.keepAttr = false;
    }
    // Paint attributes fetch through url(…) — `url(#gradient)` stays.
    if (
      data.attrValue &&
      PAINT_URL_ATTRS.includes(data.attrName.toLowerCase()) &&
      hasExternalUrlReference(data.attrValue)
    ) {
      data.attrValue = "";
      data.keepAttr = false;
    }
  });

  const result = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject", "use"],
    // Explicitly add style and common SVG attributes that might be needed
    ADD_ATTR: ["style", "fill", "stroke", "class", "transform", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height", "viewBox", "xmlns", "marker-end", "marker-start", "href"],
    // `form` comes in with the html profile, which foreignObject labels need,
    // and a form is the one element here that posts: submitting it would
    // navigate the app's own page to an address the document chose. No
    // diagram renderer emits one. Its content is kept — only the element
    // that submits goes.
    FORBID_TAGS: ["script", "form"],
    FORBID_ATTR: [
      "onerror",
      "onload",
      "onclick",
      "onmouseover",
      "onfocus",
      "onblur",
    ],
    // Allow HTML elements inside SVG foreignObject (mermaid's htmlLabels)
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });

  purify.removeAllHooks();
  return result;
}
