/**
 * Confine an SVG's own stylesheet to that SVG.
 *
 * Purpose: an SVG `<style>` element is a stylesheet for the WHOLE page it
 * lands in. A preview renders document SVG into the app's own page, so
 * `<svg><style>body *{visibility:hidden}</style></svg>` in a fence hid the
 * app, and `@keyframes popup-fade-in{…}` redefined one of the app's own
 * animations. This rewrites the sheet so every rule can only match elements
 * inside the SVG that carries it.
 *
 * Key decisions:
 *   - Scoping by SELECTOR, not by shadow root. A shadow root would hide the
 *     diagram from everything that reads it through the light DOM: print and
 *     export serialize the editor with `innerHTML` (shadow content is not
 *     serialized, and the serializing API postdates the app's WebKit floor),
 *     the app's own diagram CSS styles the SVG on purpose, and pan/zoom and
 *     the link guard find the SVG and its anchors through the light DOM.
 *   - Each selector S becomes `:is([attr="K"], [attr="K"] *):is(S)`: the
 *     element must match S AND be the marked SVG root or inside it. No
 *     selector, combinator or `:has()` can then reach anything else.
 *   - The sheet is PARSED by the engine (a constructed stylesheet, which
 *     belongs to no document and fetches nothing) and re-serialized from the
 *     object model, never spliced as text. What is emitted is the parser's
 *     own canonical form, so no string trick can put structure into it.
 *   - The output is then parsed again and checked: every selector must carry
 *     the prefix and end where `:is(` closes. If the engine reads it any other
 *     way, the whole sheet is dropped — the fail-safe direction.
 *   - Only style rules, `@media` and `@keyframes` survive. Everything else
 *     has a page-wide effect that no selector can confine (`@font-face`,
 *     `@property`, `@page`, `@layer`, `@import`, …). Keyframes are renamed
 *     into a per-scope namespace, with the references in the same sheet.
 *   - Declarations go through the shared value filter, which also drops
 *     `position: fixed|sticky`; a same-document `url(#id)` paint server is
 *     the one `url()` allowed.
 *
 * @coordinates-with svgSanitize.ts — writes the scope attribute and calls this
 * @coordinates-with styleSafety.ts — the declaration value filter
 * @coordinates-with svgResourcePolicy.ts — which references may reach the network
 * @module utils/svgStylesheetScope
 */

import { normalizeCss } from "./cssNormalize";
import { hasExternalUrlReference } from "./svgResourcePolicy";
import { isSafeStyleValue } from "./styleSafety";
import { diagramWarn } from "./debug";

/** The attribute that marks an SVG root as the scope of its stylesheet. */
export const SVG_STYLE_SCOPE_ATTR = "data-vmark-svg-scope";

// CSSRule.type values. Named here because a constructed sheet's rules are
// classified by type, and the engine's constants are not on every global.
const STYLE_RULE = 1;
const MEDIA_RULE = 4;
const KEYFRAMES_RULE = 7;

/** A keyframes name, or a property name, the rewrite can emit verbatim. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PROPERTY_NAME = /^(?:--)?-?[A-Za-z_][A-Za-z0-9_-]*$/;
/** A keyframe selector: `from`, `to`, or percentages. */
const KEYFRAME_TEXT = /^(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*$/;
/** A trailing pseudo-element, which may not appear inside `:is()`. */
const PSEUDO_ELEMENT_SUFFIX = /(?:::?(?:before|after|first-line|first-letter)|::[A-Za-z][A-Za-z0-9-]*)$/;
/** A same-document `url(#id)` paint server reference. */
const LOCAL_URL = /url\(\s*(?:"#[^"]*"|'#[^']*'|#[^)\s"']*)\s*\)/gi;

/** `:is(root, root *)` for one scope. */
function scopePrefix(key: string): string {
  const root = `[${SVG_STYLE_SCOPE_ATTR}="${key}"]`;
  return `:is(${root}, ${root} *)`;
}

/** Parse `css` in a constructed sheet, or `null` where the engine cannot. */
function parse(css: string): CSSRuleList | null {
  if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) {
    return null;
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet.cssRules;
}

/**
 * Split a selector list at its top-level commas — not inside `()`, `[]`,
 * a string, or after a backslash.
 */
export function splitSelectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
    } else if (ch === ")" || ch === "]") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** One selector, confined to the scope. */
function scopeSelector(selector: string, prefix: string): string {
  const pseudo = PSEUDO_ELEMENT_SUFFIX.exec(selector)?.[0] ?? "";
  const base = selector.slice(0, selector.length - pseudo.length).trim();
  return `${prefix}:is(${base || "*"})${pseudo}`;
}

/** A declaration value that neither fetches, executes nor pins to the viewport. */
function isSafeDeclaration(property: string, value: string): boolean {
  if (!PROPERTY_NAME.test(property)) return false;
  if (hasExternalUrlReference(value)) return false;
  return isSafeStyleValue(value.replace(LOCAL_URL, ""), property);
}

/** Point animation references at the renamed keyframes of this sheet. */
function renameAnimations(value: string, renames: ReadonlyMap<string, string>): string {
  return value
    .split(",")
    .map((layer) =>
      layer
        .split(/(\s+)/)
        .map((token) => renames.get(token) ?? token)
        .join(""),
    )
    .join(",");
}

/** `prop: value; …` for the declarations that survive the filter. */
function declarations(style: CSSStyleDeclaration, renames: ReadonlyMap<string, string>): string {
  const kept: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const property = style[i];
    let value = style.getPropertyValue(property);
    if (!isSafeDeclaration(property, value)) continue;
    if (property === "animation" || property === "animation-name") {
      value = renameAnimations(value, renames);
    }
    const important = style.getPropertyPriority(property) ? " !important" : "";
    kept.push(`${property}: ${value}${important}`);
  }
  return kept.join("; ");
}

/** Keyframes names defined anywhere in `rules`, mapped to their scoped names. */
function keyframeRenames(rules: CSSRuleList, key: string, into = new Map<string, string>()) {
  for (const rule of Array.from(rules)) {
    if (rule.type === KEYFRAMES_RULE) {
      const { name } = rule as CSSKeyframesRule;
      if (PLAIN_NAME.test(name)) into.set(name, `vmark-${key}-${name}`);
    } else if (rule.type === MEDIA_RULE) {
      keyframeRenames((rule as CSSMediaRule).cssRules, key, into);
    }
  }
  return into;
}

/** Re-serialize `rules`, keeping only what the scope can confine. */
function emit(rules: CSSRuleList, prefix: string, renames: ReadonlyMap<string, string>): string {
  let out = "";
  for (const rule of Array.from(rules)) {
    if (rule.type === STYLE_RULE) {
      const { selectorText, style } = rule as CSSStyleRule;
      const body = declarations(style, renames);
      const selectors = splitSelectorList(selectorText).map((s) => scopeSelector(s, prefix));
      if (body && selectors.length) out += `${selectors.join(", ")} { ${body} }\n`;
    } else if (rule.type === MEDIA_RULE) {
      const media = rule as CSSMediaRule;
      const inner = emit(media.cssRules, prefix, renames);
      if (inner && !/[{};]/.test(media.media.mediaText)) {
        out += `@media ${media.media.mediaText} {\n${inner}}\n`;
      }
    } else if (rule.type === KEYFRAMES_RULE) {
      const keyframes = rule as CSSKeyframesRule;
      const name = renames.get(keyframes.name);
      if (!name) continue;
      const frames = Array.from(keyframes.cssRules)
        .map((frame) => frame as CSSKeyframeRule)
        .filter((frame) => KEYFRAME_TEXT.test(frame.keyText))
        .map((frame) => `${frame.keyText} { ${declarations(frame.style, renames)} }`);
      out += `@keyframes ${name} { ${frames.join(" ")} }\n`;
    }
    // Every other rule type has a page-wide effect and is dropped.
  }
  return out;
}

/** Whether every rule in `rules` is confined, as the engine reads it. */
function isConfined(rules: CSSRuleList, prefix: string, key: string): boolean {
  for (const rule of Array.from(rules)) {
    if (rule.type === STYLE_RULE) {
      for (const selector of splitSelectorList((rule as CSSStyleRule).selectorText)) {
        if (!selector.startsWith(`${prefix}:is(`)) return false;
        // After the `:is(…)` that holds the original selector, only a single
        // pseudo-element may follow — no combinator, no second compound.
        const close = closingParen(selector, prefix.length + ":is".length);
        if (close < 0) return false;
        const rest = selector.slice(close + 1);
        if (rest !== "" && PSEUDO_ELEMENT_SUFFIX.exec(rest)?.[0] !== rest) return false;
      }
    } else if (rule.type === MEDIA_RULE) {
      if (!isConfined((rule as CSSMediaRule).cssRules, prefix, key)) return false;
    } else if (rule.type === KEYFRAMES_RULE) {
      if (!(rule as CSSKeyframesRule).name.startsWith(`vmark-${key}-`)) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * The prefix as this engine serializes it, read back from a probe rule — the
 * check compares against the engine's spelling, not the one written here.
 */
function canonicalPrefix(prefix: string): string | null {
  const probe = parse(`${prefix}:is(a) {}`)?.[0] as CSSStyleRule | undefined;
  const text = probe?.selectorText ?? "";
  return text.endsWith(":is(a)") ? text.slice(0, -":is(a)".length) : null;
}

/**
 * Rewrite stylesheet text so it can only style the SVG root marked with
 * `SVG_STYLE_SCOPE_ATTR="<key>"` and its descendants. Returns `""` — no
 * stylesheet — where the engine cannot parse one or the result fails the
 * confinement check.
 */
export function scopeStylesheet(css: string, key: string): string {
  // Comments and escapes resolved first, so the parser and every check see
  // the same text; `@import` removed before anything parses it.
  let text = normalizeCss(css);
  while (/@import/i.test(text)) text = text.replace(/@import[^;]*;?/gi, "");
  const rules = parse(text);
  if (!rules) return "";
  const prefix = scopePrefix(key);
  const out = emit(rules, prefix, keyframeRenames(rules, key));
  if (!out) return "";
  // `<` is never needed in CSS outside a string, and resolving escapes can
  // put `</style><img …>` into one. An HTML <style> serializes its text raw,
  // so that string would close the element and start markup.
  if (out.includes("<")) {
    diagramWarn("Dropped an SVG stylesheet that spelled markup through CSS escapes");
    return "";
  }
  const enginePrefix = canonicalPrefix(prefix);
  const reparsed = parse(out);
  if (!enginePrefix || !reparsed || !isConfined(reparsed, enginePrefix, key)) {
    diagramWarn("Dropped an SVG stylesheet that could not be confined to its diagram");
    return "";
  }
  return out;
}
