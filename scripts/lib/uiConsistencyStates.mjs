/**
 * C9 of the ui-consistency gate: hover/active/selected backgrounds speak the
 * state vocabulary, a selected label keeps its ink, and an enabled control
 * never rests at the tertiary ink. Pure functions over source text.
 *
 * @coordinates-with scripts/lib/uiConsistencyCss.mjs — re-exports this check to the CLI
 * @coordinates-with scripts/lib/uiConsistencyCssRules.mjs — rule iteration and markers
 * @module scripts/lib/uiConsistencyStates
 */
import { rulesWithMarkers, splitSelectorList, uiOkMarkers } from "./uiConsistencyCssRules.mjs";

const HOVER_VOCAB = ["--hover-bg", "--hover-bg-strong", "--bg-tertiary", "--subtle-bg", "--subtle-bg-hover"];
const ACTIVE_VOCAB = ["--hover-bg-strong", "--accent-bg"];
const SELECTED_VOCAB = ["--accent-bg"];
/** Selector families whose state fills are sanctioned elsewhere, with where. */
const SANCTIONED = [
  /context-menu|-menu__item|menu-item/, // rule 32 "Popups": a hovered menu item takes the accent fill
  /::-webkit-scrollbar/, // rule 32 "Other patterns": scrollbar thumb colours
  /resize-handle|divider/, // resize handles light up on drag, not a selection
  /\.vm-btn|\.popup-icon-btn|\.universal-toolbar-btn|\.toolbar-btn/, // canonical controls own their states
];
/**
 * Semantic fills are judged by VALUE: a danger/success state may take its
 * token. (A selector that merely SAYS "error" once exempted any fill at all;
 * the token must be the value itself, not a `var()` fallback that never
 * applies.)
 */
const SEMANTIC_FILL = /^var\(\s*--(?:error|danger|warning|success)[-\w]*/;

/**
 * A selected / checked / pressed / current state, in every spelling the
 * codebase uses: `.active`/`.selected`/`.is-selected`-style classes, BEM
 * `--active` modifiers, ARIA and data-* state attributes, `:checked`. An
 * attribute EXPLICITLY false (`[aria-selected="false"]`) is the opposite of a
 * selection, and `.is-loading`-style classes are not selections at all.
 */
const SELECTION_WORD = "selected|active|checked|current|pressed";
const SELECTED_STATE = new RegExp(
  `\\.(?:is-)?(?:${SELECTION_WORD})\\b(?!-)|--(?:${SELECTION_WORD}|on)\\b|\\[data-(?:active|selected|checked|pinned)\\s*(?:\\]|=(?!\\s*["']?\\s*false))|\\[aria-(?:selected|checked|pressed|current)\\s*(?:\\]|=(?!\\s*["']?\\s*false))|:checked\\b`,
);
/** Accent inks a selected LABEL must not take (R6: selection keeps its ink). */
const ACCENT_INK = /(?:^|[;{\s])color\s*:\s*var\(\s*(--accent-primary|--primary-color|--browser-accent-primary)\b/;
/** Where accent ink IS the design: the selection's icon or indicator — read on the TARGET only. */
const INDICATOR_TARGET = /::?(before|after)\b|^svg\b|^path\b|\s(svg|path)\b|[-_](icon|check|dot|glyph|indicator|chevron|caret)\b/;

/**
 * A selector with its `:is()`/`:where()` groups expanded into the complex
 * selectors they stand for: `:is(.row.selected, .row-icon)` is two selectors,
 * and only one of them is an icon. Capped, since each group multiplies.
 */
function expandMatches(selector, budget = 64) {
  const m = /:(?:is|where|matches|-webkit-any)\(/.exec(selector);
  if (!m) return [selector];
  let depth = 1;
  let end = m.index + m[0].length;
  for (; end < selector.length && depth > 0; end += 1) {
    if (selector[end] === "(") depth += 1;
    else if (selector[end] === ")") depth -= 1;
  }
  const inner = selector.slice(m.index + m[0].length, end - 1);
  const out = [];
  for (const alt of splitSelectorList(inner)) {
    for (const expanded of expandMatches(selector.slice(0, m.index) + alt + selector.slice(end), budget)) {
      if (out.length >= budget) return out;
      out.push(expanded);
    }
  }
  return out;
}

/** A selector in a selected state — `:not(...)` and explicit false excluded. */
function isSelectedSelector(selector) {
  // A state inside :not(...) is the OPPOSITE of a selection.
  return SELECTED_STATE.test(selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, ""));
}

/**
 * The last compound of a selector — the element the rule actually styles.
 * Split on combinators at the top level only: the spaces in
 * `[aria-selected = "true"]` or `:not(.a .b)` are not combinators.
 */
function targetCompound(selector) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return selector.slice(start) || selector;
}

/**
 * C9 (ink) — a selected label keeps --text-color (rule 30, R6).
 *
 * The background half reads only `background`, so `color:
 * var(--accent-primary)` on a selected TEXT label passed everywhere, including
 * the canonical `.vm-chip--toggle`. Both halves read selection through
 * `isSelectedSelector` — BEM modifiers, ARIA and data-* states, `:not()` and
 * explicit false excluded — which the background half once lacked. Each selector in a list is
 * judged on its own; indicator words are read from its TARGET compound only
 * (an ancestor named `.list-check` does not make `.row.active` an icon).
 * Icon-only controls, whose glyph IS the indicator, say so with
 * `ui-ok(state): <reason>`.
 */
function checkSelectionInk(css, file, { problems }) {
  const findings = [];
  for (const rule of rulesWithMarkers(css)) {
    if (!ACCENT_INK.test(rule.body)) continue;
    const { markers, problems: mp } = uiOkMarkers(rule.rawBody);
    problems.push(...mp.map((p) => `${file}:${rule.selector}: ${p}`));
    if (markers.has("state")) continue;
    for (const selector of splitSelectorList(rule.selector)) {
      // Indicator words count only where they name the styled element: an
      // icon inside `:not(...)` or `:has(...)` is some OTHER element.
      const labels = expandMatches(selector).filter(
        (alt) =>
          isSelectedSelector(alt) &&
          !INDICATOR_TARGET.test(targetCompound(alt).replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, "")) &&
          !/::?(before|after)\b/.test(alt),
      );
      if (labels.length === 0) continue;
      findings.push({
        check: "C9",
        id: `${file}:${selector} (ink)`,
        message: `${file}:${rule.line} ${selector}: a selected label in accent ink — selection keeps its ink (rule 30, R6): var(--accent-bg) fill, color var(--text-color); accent goes on the icon/indicator. Icon-only control? ui-ok(state): <reason>.`,
      });
    }
  }
  return findings;
}

/** C9 — hover/active/selected backgrounds speak the state vocabulary. */
export function checkStateVocabulary(css, file, { problems }) {
  const findings = checkSelectionInk(css, file, { problems });
  const seen = new Set();
  // R5 — tertiary is decorative/disabled ink: an ENABLED control
  // (`-btn|-toggle|-close` selector outside :disabled) may not rest at
  // `--text-tertiary`. Measured 0 on adoption, so no baseline entries exist
  // and none may be added.
  for (const rule of rulesWithMarkers(css)) {
    if (!/(-btn\b|-toggle\b|-close\b)/.test(rule.selector)) continue;
    if (/:disabled|\[disabled\]|::(before|after)/.test(rule.selector)) continue;
    if (!/(?:^|[;{])\s*color\s*:\s*var\(--text-tertiary\)/.test(rule.body)) continue;
    const { markers } = uiOkMarkers(rule.rawBody);
    if (markers.has("state")) continue;
    findings.push({
      check: "C9",
      id: `${file}:${rule.selector}`,
      message: `${file}:${rule.line} ${rule.selector}: an enabled control resting at --text-tertiary — decorative/disabled ink only (R5); rest at --text-secondary.`,
    });
  }
  for (const rule of rulesWithMarkers(css)) {
    const bg = /(?:^|[;{])\s*background(?:-color)?\s*:\s*([^;}]+)/.exec(rule.body);
    if (!bg) continue;
    const value = bg[1].trim();
    if (/^(transparent|none|inherit|unset|initial)$/.test(value) || SEMANTIC_FILL.test(value)) continue;
    let markers = null;
    // Each selector in a list is judged on its own, with the same selected-
    // state reading as the ink half: BEM `--active`, ARIA and data-* states.
    for (const selector of splitSelectorList(rule.selector)) {
      // Each alternative of `:is()`/`:where()` is judged on its own: a
      // sanctioned `.menu-item:hover` alternative exempts only itself, never a
      // selected row grouped beside it.
      const offending = expandMatches(selector)
        .map((alt) => {
          if (/::(before|after)/.test(alt)) return null; // indicators, not fills
          const isHover = /:hover/.test(alt);
          const isActivePseudo = /:active\b/.test(alt);
          const isSelected = isSelectedSelector(alt);
          if (!isHover && !isActivePseudo && !isSelected) return null;
          if (SANCTIONED.some((re) => re.test(alt))) return null;
          const vocab = isSelected ? SELECTED_VOCAB : isHover ? HOVER_VOCAB : ACTIVE_VOCAB;
          if (vocab.some((t) => value.includes(`var(${t}`) || value.includes(`var(${t})`))) return null;
          if (HOVER_VOCAB.concat(ACTIVE_VOCAB, SELECTED_VOCAB).some((t) => value.includes(t)) && !isSelected) return null;
          return { isHover, isSelected };
        })
        .find(Boolean);
      if (!offending) continue;
      const { isHover, isSelected } = offending;
      if (!markers) {
        const parsed = uiOkMarkers(rule.rawBody);
        problems.push(...parsed.problems.map((p) => `${file}:${rule.selector}: ${p}`));
        markers = parsed.markers;
      }
      if (markers.has("state")) break;
      const id = `${file}:${selector}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const want = isSelected
        ? "selected rows use var(--accent-bg) (+ color var(--text-color))"
        : isHover
          ? "hover uses --hover-bg/--hover-bg-strong/--bg-tertiary/--subtle-bg"
          : ":active uses --hover-bg-strong";
      findings.push({
        check: "C9",
        id,
        message: `${file}:${rule.line} ${selector} background: ${value} — ${want} (rule 30/32), or ui-ok(state): <reason>.`,
      });
    }
  }
  return findings;
}
