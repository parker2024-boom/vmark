/**
 * Shared CSS parsing for the UI gates.
 *
 * Extracted from scripts/check-bespoke-buttons.mjs so the token gate, the
 * button gate and the ui-consistency gate cannot parse CSS differently: one
 * regex grammar, one comment-stripping rule, one "value of prop in body"
 * reader. Flat component CSS only — no nesting — which is what this repo
 * writes (media queries produce one outer match whose body contains the inner
 * rules; callers that care use `cssRules` on the inner text again).
 *
 * @coordinates-with scripts/check-bespoke-buttons.mjs — original home; imports from here
 * @coordinates-with scripts/check-design-tokens.mjs, scripts/check-ui-consistency.mjs
 */

/** Every `selector { body }` pair; good enough for flat component CSS. */
export const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;

/** Comments out, replaced by a single space (collapses layout). */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Comments blanked but LENGTH-PRESERVING (newlines kept), so indexes into the
 * result still map to the original text — line numbers survive.
 */
export function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** The value a rule body declares for `prop`, or null. Last declaration wins. */
export function declaredValue(body, prop) {
  const re = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`, "gi");
  let found = null;
  for (const m of stripComments(body).matchAll(re)) found = m[1].trim();
  return found;
}

/**
 * Braces inside quoted strings blanked, LENGTH-PRESERVING: `content: "}"` or
 * `--label: "{"` would otherwise end or open a rule for the brace grammar.
 * Used to FIND rules; the text handed back is sliced from the unblanked input.
 */
function blankStringBraces(css) {
  // An unterminated string (no closing quote before the line ends) is left
  // alone, as a browser's tokenizer ends it at the newline.
  return css.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (str) => str.replace(/[{}]/g, " "));
}

/** 1-based line number of `index` within `text`. */
export function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Iterate `{selector, body, index, bodyIndex, line}` over a stylesheet.
 * `selector` has comments stripped and whitespace collapsed; `index` points at
 * the first significant character of the selector in the ORIGINAL text.
 */
export function* cssRules(css) {
  const blanked = blankComments(css);
  // Lines are counted incrementally: `lineOf` per rule re-splits the file
  // from the start, quadratic in the file's length.
  let line = 1;
  let counted = 0;
  // Rules are FOUND on a copy with in-string braces blanked, and their text
  // SLICED from `blanked`, so a string value reaches callers unaltered.
  for (const m of blankStringBraces(blanked).matchAll(CSS_RULE_RE)) {
    const rawSelector = blanked.slice(m.index, m.index + m[1].length);
    const offset = rawSelector.search(/\S/);
    const index = m.index + (offset === -1 ? 0 : offset);
    const bodyIndex = m.index + m[1].length + 1;
    for (; counted < index; counted += 1) if (css.charCodeAt(counted) === 10) line += 1;
    yield {
      selector: rawSelector.replace(/\s+/g, " ").trim(),
      body: blanked.slice(bodyIndex, bodyIndex + m[2].length),
      index,
      bodyIndex,
      line,
    };
  }
}
