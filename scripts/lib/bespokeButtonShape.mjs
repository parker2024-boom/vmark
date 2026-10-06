/**
 * The bespoke-button gate's SHAPE measurement: the canonical `.vm-btn` triple
 * (padding, radius, font size), token resolution, and the `<button>` classes
 * whose base rule chooses a different value. Pure functions; files are read
 * through the injected `readFile`.
 *
 * @coordinates-with scripts/check-bespoke-buttons.mjs — the CLI, which re-exports these
 * @coordinates-with scripts/lib/bespokeButtonUsage.mjs — the `<button>` class reading
 * @coordinates-with scripts/lib/cssRules.mjs — the one CSS grammar
 * @module scripts/lib/bespokeButtonShape
 */
import { readFileSync } from "node:fs";
import { CSS_RULE_RE, stripComments, declaredValue } from "./cssRules.mjs";
import { CANONICAL_BARE, collectClassesAppliedToButtons } from "./bespokeButtonUsage.mjs";

/* ------------------------------------------------------------------------- *
 * Third measurement: the control triple.
 *
 * The by-name and by-usage budgets count CONTROLS. They cannot see the drift that survives
 * a fully tokenised codebase: `.vm-btn` is 6/12 + radius-sm + font-sm, and
 * `.approval-dialog__btn` was 6/14 + radius-md + font-md. Both pass every token
 * check, because each value IS a token — just not the same one. Side by side
 * they read as two products.
 *
 * So this compares WHICH token was chosen, against `.vm-btn` itself rather than
 * a hardcoded copy of it, and reports a diff rather than a count — the useful
 * output is "change this to that", not "you are over budget".
 * ------------------------------------------------------------------------- */

/** The three properties that define a button's shape. */
export const SHAPE_PROPERTIES = ["padding", "border-radius", "font-size"];

/**
 * Does this rule body carry an exemption WITH a stated reason?
 *
 * A regex over the raw body cannot do this: `/button-shape-ok\s*:\s*\S/` was
 * satisfied by the `*` of the closing `*​/`, so `button-shape-ok:` with nothing
 * after it read as a stated reason — precisely the mute button the required-reason
 * rule exists to forbid. So take the comment CONTENTS first, then judge the text.
 */
function hasExemptionReason(body) {
  for (const m of body.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    const marker = /button-shape-ok\s*:([\s\S]*)/.exec(m[1]);
    if (!marker) continue;
    // A reason has to be words, not punctuation left over from the marker.
    if (/[a-z0-9]/i.test(marker[1])) return true;
  }
  return false;
}

/** `--token: value` declarations, for resolving one spelling against another. */
export function buildTokenMap(css) {
  const map = new Map();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
    map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

/**
 * Resolve `var(--x)` to its literal so `6px 12px` and
 * `var(--space-1-5) var(--space-3)` compare equal. Comparing authored TEXT
 * would flag a same-shape control for spelling its values differently, which is
 * a false positive, and a gate that cries wolf gets routed around.
 *
 * An unknown token resolves to itself rather than to a guess.
 */
export function resolveValue(value, tokens) {
  let out = String(value).trim();
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^()]*)?\)/gi, (whole, name) =>
      tokens.has(name) ? tokens.get(name) : whole,
    );
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The canonical triple, read from `.vm-btn` in button-shared.css.
 *
 * Read rather than hardcoded: a copy here would be a fourth surface to keep in
 * sync, which is the exact defect this gate exists to catch. Fails closed — if
 * the primitive is renamed or stops declaring one of the three, that is a
 * finding, not a reason to skip the check.
 */
export function canonicalTriple(css) {
  const block = /(?:^|})[^{}]*\.vm-btn\s*\{([^{}]*)\}/m.exec(`}${css}`);
  if (!block) throw new Error("Cannot find a `.vm-btn` rule in the shared button stylesheet.");
  const triple = {};
  for (const prop of SHAPE_PROPERTIES) {
    const value = declaredValue(block[1], prop);
    if (!value) throw new Error(`\`.vm-btn\` no longer declares \`${prop}\`; the canonical triple is incomplete.`);
    triple[prop] = value;
  }
  return triple;
}

/**
 * Classes applied to a `<button>` whose declared shape diverges from canonical.
 *
 * Only the BASE rule counts. Bodies are concatenated per class by the usage
 * measurement, which is fine for "does this re-derive a surface" but wrong here: a
 * `:focus-visible::after` ring legitimately carries its own `border-radius`, and
 * folding it in would report every correctly-built button as drift.
 *
 * A property the class never declares is not drift — it inherits, or it does not
 * care. Only an explicit, different choice is reported.
 */
export function collectShapeDrift(tsxFiles, cssFiles, { canonical, tokens }, readFile = (p) => readFileSync(p, "utf8")) {
  const appliedToButton = collectClassesAppliedToButtons(tsxFiles, readFile);

  // Base rules only: a selector mentioning the class with no pseudo attached.
  const baseBody = new Map();
  for (const file of cssFiles) {
    for (const rule of readFile(file).matchAll(CSS_RULE_RE)) {
      // Comments are folded into the selector capture by CSS_RULE_RE, so a
      // colon inside one (this repo writes `/* focus: caret-only … */` above
      // real rules) made the whole base rule look like a pseudo-selector and
      // vanish. Strip comments before deciding.
      const selector = stripComments(rule[1]);
      for (const part of selector.split(",")) {
        if (part.includes(":")) continue;
        for (const cls of part.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
          baseBody.set(cls[1], (baseBody.get(cls[1]) ?? "") + rule[2]);
        }
      }
    }
  }

  const found = new Map();
  for (const [cls, file] of appliedToButton) {
    if (CANONICAL_BARE.test(cls)) continue;
    const body = baseBody.get(cls);
    if (!body || hasExemptionReason(body)) continue;

    const diffs = [];
    for (const prop of SHAPE_PROPERTIES) {
      const actual = declaredValue(body, prop);
      if (actual === null) continue;
      if (resolveValue(actual, tokens) === resolveValue(canonical[prop], tokens)) continue;
      diffs.push({ property: prop, actual, expected: canonical[prop] });
    }
    if (diffs.length) found.set(cls, { file, diffs });
  }
  return found;
}
