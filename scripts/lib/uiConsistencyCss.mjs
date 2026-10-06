/**
 * CSS-side checks of the ui-consistency gate: C3, C4, C5, C8 and
 * C10's class→focus-paint map here; C9 and C11/C12 live in sibling modules and
 * are re-exported, so this file stays the one import for the CLI. Pure
 * functions over source text; the CLI owns files, the baseline and the exit code.
 *
 * Shared exemption grammar: `/* ui-ok(<check>): <reason> *\/` INSIDE the rule
 * body, `<check>` ∈ overlay|target|state|font|icon|height|focus|float. A marker
 * with no reason (or punctuation only) is refused — the same rule as
 * `focus: caret-only` and `button-shape-ok`.
 *
 * @coordinates-with scripts/check-ui-consistency.mjs — the CLI
 * @coordinates-with scripts/lib/uiConsistencyTsx.mjs — the TSX half
 * @coordinates-with scripts/lib/uiConsistencyCssRules.mjs — markers, tokens, rule iteration
 * @coordinates-with scripts/lib/uiConsistencyStates.mjs — C9
 * @coordinates-with scripts/lib/uiConsistencyLayers.mjs — C11, C12
 * @coordinates-with scripts/lib/cssRules.mjs — the one CSS grammar
 */
import { stripComments } from "./cssRules.mjs";
import { isEditorScoped, resolveNumeric, rulesWithMarkers, uiOkMarkers } from "./uiConsistencyCssRules.mjs";

export { indexTokens, uiOkMarkers } from "./uiConsistencyCssRules.mjs";
export { checkStateVocabulary } from "./uiConsistencyStates.mjs";
export { checkFloatingOverContent, checkHeightsAndZ } from "./uiConsistencyLayers.mjs";

/** C3 — chrome font-size must be a token; editor em ratios are exempt. */
export function checkFontSize(css, file, { problems }) {
  const findings = [];
  for (const rule of rulesWithMarkers(css)) {
    const { markers, problems: mp } = uiOkMarkers(rule.rawBody);
    problems.push(...mp.map((p) => `${file}:${rule.selector}: ${p}`));
    for (const m of rule.body.matchAll(/(?:^|[;{])\s*font-size\s*:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      if (/var\(--(?:font-size|editor-font-size)/.test(value)) continue;
      if (/^(inherit|unset|initial)$/.test(value)) continue;
      if (isEditorScoped(rule.selector) && /(em|%)\s*$/.test(value)) continue;
      if (markers.has("font")) continue;
      findings.push({
        check: "C3",
        id: `${file}:${rule.selector}`,
        message: `${file}:${rule.line} font-size: ${value} — chrome type uses a --font-size-* token (or an em ratio under an editor selector). See rule 31.`,
      });
      break; // one identity per rule
    }
  }
  return findings;
}

/** C4 — a fixed, high-z shell whose panel is not a canonical class. */
export function checkOverlayShell(css, file, tokens, { problems }) {
  const zFloor = resolveNumeric("var(--z-context-menu)", tokens) ?? 1000;
  let shellRule = null;
  for (const rule of rulesWithMarkers(css)) {
    if (!/position\s*:\s*fixed/.test(rule.body)) continue;
    const z = /(?:^|[;{])\s*z-index\s*:\s*([^;}]+)/.exec(rule.body);
    if (!z) continue;
    const zv = resolveNumeric(z[1], tokens);
    if (zv === null || zv < zFloor) continue;
    const { markers, problems: mp } = uiOkMarkers(rule.rawBody);
    problems.push(...mp.map((p) => `${file}:${rule.selector}: ${p}`));
    if (markers.has("overlay")) continue;
    if (/\.(popup-container|media-popup|vm-overlay|vm-menu)\b/.test(rule.selector)) continue;
    shellRule = shellRule ?? rule;
  }
  if (!shellRule) return [];
  // Panel: the shell rule itself, or a sibling rule with the popup surface.
  let panel = null;
  for (const rule of rulesWithMarkers(css)) {
    const hasShadow = /box-shadow\s*:\s*var\(--popup-shadow/.test(rule.body);
    const hasBorderPanel =
      /(?:^|[;{])\s*border\s*:/.test(rule.body) && /border-radius\s*:\s*var\(--radius-lg\)/.test(rule.body);
    if (!hasShadow && !hasBorderPanel) continue;
    if (/\.(popup-container|media-popup|vm-overlay|vm-menu)\b/.test(rule.selector)) return [];
    const { markers } = uiOkMarkers(rule.rawBody);
    if (markers.has("overlay")) return [];
    panel = panel ?? rule;
  }
  const key = panel ?? shellRule;
  return [
    {
      check: "C4",
      id: `${file}:${key.selector}`,
      message: `${file}:${key.line} ${key.selector}: overlay/popup shell restated — use .vm-overlay__panel/.vm-menu/.popup-container (WI-UI3.1/3.2), or mark the rule ui-ok(overlay): <reason>.`,
    },
  ];
}

/** C5 — var(--font-sans) belongs to the document, not chrome. */
export function checkFontSans(css, file, { problems }) {
  const findings = [];
  for (const rule of rulesWithMarkers(css)) {
    if (!/var\(--font-sans\b/.test(rule.body)) continue;
    if (isEditorScoped(rule.selector)) continue;
    const { markers, problems: mp } = uiOkMarkers(rule.rawBody);
    problems.push(...mp.map((p) => `${file}:${rule.selector}: ${p}`));
    if (markers.has("font")) continue;
    findings.push({
      check: "C5",
      id: `${file}:${rule.selector}`,
      message: `${file}:${rule.line} ${rule.selector}: --font-sans is the READING font (written from settings); chrome uses var(--font-ui) (WI-UI2.1).`,
    });
  }
  return findings;
}

const TARGETY_SELECTOR = /(btn|button|-close\b|-toggle\b|handle|chevron|arrow|-action\b|-tab\b)/;

/** C8 — clickable smaller than the 24px target floor with no expander. */
export function checkTargets(css, file, tokens, { problems }) {
  const findings = [];
  const expanders = new Set();
  for (const rule of rulesWithMarkers(css)) {
    if (/::(before|after)/.test(rule.selector) && /position\s*:\s*absolute/.test(rule.body)) {
      expanders.add(rule.selector.replace(/::(before|after).*$/, "").trim());
    }
  }
  const seen = new Set();
  for (const rule of rulesWithMarkers(css)) {
    if (/::(before|after)/.test(rule.selector)) continue;
    const base = rule.selector;
    if (!TARGETY_SELECTOR.test(base)) continue;
    if (/\b(svg|img|span|i)\s*$/.test(base)) continue; // glyph child, not the hit box
    if (/:(hover|active|focus|disabled)/.test(base)) continue; // state variants restate the box
    let below = false;
    for (const m of rule.body.matchAll(/(?:^|[;{])\s*(width|height|min-width|min-height)\s*:\s*([^;}]+)/g)) {
      const n = resolveNumeric(m[2], tokens);
      if (n !== null && n > 0 && n < 24) below = true;
    }
    if (!below) continue;
    const { markers, problems: mp } = uiOkMarkers(rule.rawBody);
    problems.push(...mp.map((p) => `${file}:${rule.selector}: ${p}`));
    if (markers.has("target")) continue;
    if ([...expanders].some((e) => base.startsWith(e))) continue;
    const id = `${file}:${base}`;
    if (seen.has(id)) continue; // the @media (pointer: coarse) branch is the same class
    seen.add(id);
    findings.push({
      check: "C8",
      id,
      message: `${file}:${rule.line} ${base}: hit target under 24px with no ::before expander — grow the hit box (WI-UI2.3) or mark ui-ok(target): spaced.`,
    });
  }
  return findings;
}

/** A value that renders nothing, so it cannot serve as a focus indicator. */
const INVISIBLE = /^\s*(none|transparent|0|initial|unset|inherit)\s*$/;
const INDICATOR_PROP = /(?:^|[;{])\s*(background(?:-color)?|outline|border(?:-[a-z]+)*|box-shadow|text-decoration)\s*:\s*([^;}]+)/g;

/**
 * C10's CSS half: the set of class names that paint something on
 * :focus/:focus-visible (or carry the declared caret-only marker).
 */
export function focusPaintedClasses(css) {
  const covered = new Set();
  for (const rule of rulesWithMarkers(css)) {
    // Pseudo-class and class collection use the comment-stripped selector;
    // the caret-only marker is read from the RAW views (comments included),
    // where the documented placement is a comment above the rule.
    // `:not(:focus-visible)` is a NEGATIVE focus state — blank :not() groups
    // first, or a hover rule that yields to focus reads as focus coverage
    // (universal-toolbar.css's hover rule was exactly that).
    const selector = rule.selector.replace(/:not\([^)]*\)/g, ":not()");
    const body = rule.rawBody;
    if (!/:focus(-visible|-within)?\b/.test(selector)) continue;
    let paints = false;
    INDICATOR_PROP.lastIndex = 0;
    let d;
    while ((d = INDICATOR_PROP.exec(stripComments(body))) !== null) {
      if (!INVISIBLE.test(d[2])) paints = true;
    }
    const caretOnly = /focus:\s*caret-only\s*[—–-]\s*\S/.test(rule.rawSelector) || /focus:\s*caret-only\s*[—–-]\s*\S/.test(body);
    if (!paints && !caretOnly) continue;
    // Only the compound selector that CARRIES the :focus pseudo-class is
    // focus-painted. Collecting every class in the selector marks ancestor
    // context classes (`.tiptap-editor .btn:focus-visible` covering
    // `tiptap-editor`) as covered, masking real C10 gaps.
    for (const part of selector.split(",")) {
      for (const compound of part.split(/[\s>+~]+/)) {
        if (!/:focus(-visible|-within)?\b/.test(compound)) continue;
        for (const cls of compound.matchAll(/\.([A-Za-z_][\w-]*)/g)) covered.add(cls[1]);
      }
    }
  }
  return covered;
}
