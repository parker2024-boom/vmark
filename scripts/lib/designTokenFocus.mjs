/**
 * The focus-removal check of the design-token gate: a `:focus` rule that
 * removes the outline must have a painting `:focus-visible` twin or a reasoned
 * caret-only marker. Pure function over CSS text.
 *
 * @coordinates-with scripts/check-design-tokens.mjs — the CLI, which re-exports this
 * @module scripts/lib/designTokenFocus
 */

/** A value that renders nothing, so it cannot serve as a focus indicator. */
const INVISIBLE = /^\s*(none|transparent|0|initial|unset|inherit)\s*$/;

/** Properties that can draw a visible focus affordance. */
const INDICATOR_PROP = /(?:^|[;{])\s*(background(?:-color)?|outline|border(?:-[a-z]+)*|box-shadow)\s*:\s*([^;}]+)/g;

/** Whether a declaration block paints something a sighted user can see. */
function hasVisibleIndicator(body) {
  INDICATOR_PROP.lastIndex = 0;
  let m;
  while ((m = INDICATOR_PROP.exec(body)) !== null) {
    if (!INVISIBLE.test(m[2])) return true;
  }
  return false;
}

/** Split a selector list, dropping comments. */
function selectorsOf(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `:focus` rules that remove the outline with nothing visible taking its place.
 *
 * Two things count as a replacement, and both are deliberate:
 *
 *   1. A `:focus-visible` rule on the SAME selector that paints something. This
 *      is the dominant in-repo pattern (`background: var(--hover-bg)` beside a
 *      borderless input), and a check that cannot see it is a check nobody
 *      believes.
 *   2. An explicit `/⁎ focus: caret-only — <reason> ⁎/` marker immediately above
 *      the rule. The caret IS a valid indicator for a text input
 *      (`.claude/rules/33-focus-indicators.md` §2) but no CSS analysis can see
 *      a caret, so the claim has to be written down. The REASON is required:
 *      a bare token would just be a mute button.
 *
 * Every member of a comma-separated list needs cover — one covered selector
 * does not vouch for its neighbour.
 *
 * @param {string} css
 * @returns {{ selector: string, line: number }[]}
 */
export function findFocusRemovals(css) {
  const rules = [];
  const ruleRe = /([^{}]*)\{([^}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css)) !== null) {
    rules.push({ raw: m[1], body: m[2], index: m.index });
  }

  // Selectors whose :focus-visible rule paints something.
  const covered = new Set();
  for (const rule of rules) {
    if (!hasVisibleIndicator(rule.body)) continue;
    for (const sel of selectorsOf(rule.raw)) {
      if (sel.endsWith(":focus-visible")) covered.add(sel.slice(0, -":focus-visible".length));
    }
  }

  const findings = [];
  for (const rule of rules) {
    if (!/outline\s*:\s*none/.test(rule.body)) continue;

    const focusSelectors = selectorsOf(rule.raw).filter((s) => s.endsWith(":focus"));
    if (focusSelectors.length === 0) continue; // :focus-visible etc. are not removals

    // The marker must sit in this rule's own prelude, so it cannot leak
    // forward and excuse an unrelated rule further down the file.
    if (/focus:\s*caret-only\s*[—–-]\s*\S/.test(rule.raw)) continue;

    const bases = focusSelectors.map((s) => s.slice(0, -":focus".length));
    if (bases.every((b) => covered.has(b))) continue;

    // Point at the selector itself, not at the whitespace after the previous
    // rule's closing brace.
    const blanked = rule.raw.replace(/\/\*[\s\S]*?\*\//g, (s) => " ".repeat(s.length));
    const offset = blanked.search(/\S/);
    const start = rule.index + (offset === -1 ? 0 : offset);
    findings.push({
      selector: focusSelectors[0],
      line: css.slice(0, start).split("\n").length,
    });
  }
  return findings;
}
