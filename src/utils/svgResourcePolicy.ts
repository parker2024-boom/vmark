/**
 * SVG external-resource policy.
 *
 * Purpose: decide which attribute values in sanitized SVG may reach the
 * network. An SVG (or Mermaid diagram) arriving in an untrusted document
 * must not fetch anything when the document is merely OPENED — such a fetch
 * is a beacon disclosing the reader's IP address and the moment they opened
 * the file. So a resource-loading reference may only be a same-document
 * `#fragment` or an inline `data:image/…` payload.
 *
 * Key decisions:
 *   - The rule is ELEMENT-AWARE, because "no external href" is too broad:
 *     a Mermaid `click` directive renders `<a xlink:href="https://…">`, which
 *     is navigation the reader opts into, not a load-on-open fetch. Stripping
 *     those silently broke clickable diagrams. Only elements that FETCH
 *     (`use`, `image`, `feImage`) are governed here; `<a>` is left to
 *     DOMPurify's URI policy, which already blocks `javascript:`.
 *   - `src`/`srcset`/`poster` are governed on ANY element, because HTML
 *     inside `<foreignObject>` reaches the SVG sanitizer as well — an
 *     `<img src="https://…">` there is the same beacon by another spelling.
 *   - Paint attributes (`fill`, `stroke`, `filter`, `mask`, `clip-path`,
 *     markers) can carry `url(https://…)`, which fetches exactly like an
 *     `href`. They are checked with the same rule, while `url(#gradient)` —
 *     how every real diagram references its own paint servers — is kept.
 *   - Leading whitespace and control characters are stripped before judging:
 *     a browser ignores them when resolving a URL, so `\t#x` and ` https://…`
 *     must be judged on what actually resolves.
 *
 * @coordinates-with sanitize.ts — installs this policy as a DOMPurify hook
 * @module utils/svgResourcePolicy
 */

/** Attributes that name a document to FETCH, keyed by owning element. */
const FETCHING_HREF_ELEMENTS: ReadonlySet<string> = new Set([
  "use",
  "image",
  "feimage",
]);

/** Attributes that fetch on any element (HTML inside `<foreignObject>`). */
const MEDIA_SOURCE_ATTRS: ReadonlySet<string> = new Set([
  "src",
  "srcset",
  "poster",
]);

/** Paint/reference attributes whose `url()` value fetches. */
export const PAINT_URL_ATTRS: readonly string[] = [
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
];

import { normalizeCss } from "./cssNormalize";

/** Strip what a URL parser ignores: leading/embedded C0 controls and spaces. */
function canonicalize(value: string): string {
  // eslint-disable-next-line no-control-regex -- matching C0 controls is the point: URL parsers drop them, so they are stripped before scheme checks
  return value.replace(/[\u0000-\u0020\u007f]/g, "");
}

/**
 * True for the only reference targets that never reach the network: a
 * same-document `#fragment` and an inline `data:image/…` payload. An empty
 * value is inert and therefore allowed.
 */
export function isSameDocumentOrInlineRef(value: string): boolean {
  const cleaned = canonicalize(value);
  if (cleaned === "") return true;
  if (cleaned.startsWith("#")) return true;
  return /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml)[;,]/i.test(cleaned);
}

/**
 * True when `attrName` on `<elementName>` names a resource the renderer
 * FETCHES, as opposed to a link the reader may follow.
 */
export function isResourceLoadingRef(
  elementName: string,
  attrName: string,
): boolean {
  const el = elementName.toLowerCase();
  const attr = attrName.toLowerCase();
  if (MEDIA_SOURCE_ATTRS.has(attr)) return true;
  if (attr === "href" || attr === "xlink:href") {
    return FETCHING_HREF_ELEMENTS.has(el);
  }
  return false;
}

/**
 * Every `url(...)` token in a CSS/paint value, unquoted and trimmed.
 *
 * The quoted alternatives come FIRST and consume to the closing quote, so a
 * URL containing `)` — `url("https://evil.test/a)")`, valid CSS — is read
 * whole. A single pattern that stopped at the first `)` truncated it to
 * `https://evil.test/a`… no: it failed to match at all, and the value was
 * reported clean. That is a beacon bypass, so the order here is load-bearing.
 */
function urlTokens(value: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    out.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  }
  return out;
}

/**
 * True when a paint or style value references a target outside this
 * document — `url(https://…)` fetches exactly as an `href` does, while
 * `url(#gradient)` is the same-document paint server every diagram uses.
 *
 * Deliberately belt-and-braces. The `url()` scan is the precise half; the
 * scheme/protocol-relative scan below is the blunt half, and it is what
 * holds when a value is spelled in a way the scan does not model. For these
 * attributes that bluntness costs nothing real: a legitimate paint value is
 * a color, a keyword, or `url(#id)` — none of which contain `://`.
 */
export function hasExternalUrlReference(value: string): boolean {
  const unescaped = normalizeCss(value);
  if (urlTokens(unescaped).some((url) => !isSameDocumentOrInlineRef(url))) {
    return true;
  }
  const collapsed = canonicalize(unescaped);
  if (/^data:image\//i.test(collapsed)) return false;
  return /:\/\//.test(collapsed) || /(^|[('"])\/\//.test(collapsed);
}
