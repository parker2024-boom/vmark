/**
 * Shared reading of the ui-consistency gate's CSS checks: the `ui-ok`
 * exemption markers, the `:root` token map, numeric resolution of a token
 * reference, the editor-scope test, rule iteration with raw marker views, and
 * selector-list splitting. Pure functions over source text.
 *
 * Purpose: every CSS check module reads rules and markers the same way; one
 * definition keeps a marker that exempts one check from being misread by another.
 *
 * @coordinates-with scripts/lib/uiConsistencyCss.mjs — the C3/C4/C5/C8/C10 checks
 * @coordinates-with scripts/lib/uiConsistencyStates.mjs — C9
 * @coordinates-with scripts/lib/uiConsistencyLayers.mjs — C11/C12
 * @coordinates-with scripts/lib/cssRules.mjs — the one CSS grammar
 * @module scripts/lib/uiConsistencyCssRules
 */
import { cssRules } from "./cssRules.mjs";

const UI_OK_RE = /ui-ok\((overlay|target|state|font|icon|height|focus|float)\)\s*:\s*([^*]*)/g;

/** Markers present in a rule's RAW body text (comments included). */
export function uiOkMarkers(rawBody) {
  const out = new Map();
  const problems = [];
  UI_OK_RE.lastIndex = 0;
  for (const m of rawBody.matchAll(UI_OK_RE)) {
    const reason = m[2].trim().replace(/[—–\-\s]+$/g, "");
    if (reason.length === 0 || /^[^\w]+$/.test(reason)) {
      problems.push(`ui-ok(${m[1]}) marker has no reason — state why, or delete the marker.`);
    } else {
      out.set(m[1], reason);
    }
  }
  return { markers: out, problems };
}

/** `:root` token map from index.css, with one level of var() resolved. */
export function indexTokens(indexCss) {
  const tokens = new Map();
  for (const rule of cssRules(indexCss)) {
    const sel = rule.selector.split(";").pop().trim();
    if (sel !== ":root") continue;
    for (const m of rule.body.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)/g)) {
      tokens.set(m[1], m[2].trim());
    }
  }
  for (const [k, v] of tokens) {
    const alias = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(v);
    if (alias && tokens.has(alias[1])) tokens.set(k, tokens.get(alias[1]));
  }
  return tokens;
}

/** Resolve a declaration value to a number where possible (`var(--z-popup)` → 9999). */
export function resolveNumeric(value, tokens) {
  const v = value.trim();
  const varRef = /^var\(\s*(--[A-Za-z0-9-]+)\s*(?:,[^)]*)?\)$/.exec(v);
  const raw = varRef ? (tokens.get(varRef[1]) ?? "") : v;
  const num = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(raw.trim());
  return num ? Number(num[1]) : null;
}

const EDITOR_SCOPE_RE = /\.tiptap-editor|\.ProseMirror|\.source-editor|\.cm-|\.editor-content|\.markdown-body/;

export function isEditorScoped(selector) {
  return EDITOR_SCOPE_RE.test(selector);
}

/** Iterate rules of a file WITH raw body (markers) and comment-blanked body. */
export function* rulesWithMarkers(css) {
  // cssRules blanks comments in the body, which erases the markers — but the
  // blanking is LENGTH-PRESERVING, so the blanked offsets map 1:1 into the
  // original text. Slice the raw views from the original rather than re-walking
  // it with the grammar: a comment containing `{` or `}` desynchronizes an
  // index-paired second walk, misattributing every later rule's markers.
  // rawSelector spans from the END of the previous rule, so a marker comment
  // ABOVE the rule (the documented `focus: caret-only` placement) stays
  // attached to the rule it precedes.
  let prevEnd = 0;
  for (const rule of cssRules(css)) {
    yield {
      ...rule,
      rawBody: css.slice(rule.bodyIndex, rule.bodyIndex + rule.body.length),
      rawSelector: css.slice(prevEnd, rule.bodyIndex - 1),
    };
    prevEnd = rule.bodyIndex + rule.body.length + 1;
  }
}

/** Split a selector list on top-level commas (not inside `()` or `[]`). */
export function splitSelectorList(selector) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
