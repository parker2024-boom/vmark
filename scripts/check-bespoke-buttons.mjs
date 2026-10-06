#!/usr/bin/env node
/**
 * Bespoke-button budget gate.
 *
 * VMark had 90 hand-rolled button classes against 2 canonical ones, so each
 * feature re-derived "a bordered secondary button" from the token catalogue
 * independently — and they disagreed. Four implementations of the same control
 * used four paddings, three radii, two font sizes, and three spellings of a 1px
 * border, one of which (`--space-px`) is a SPACING token misused as a border
 * width. That drift is invisible to the design-token gate, which only checks
 * that *a* token was used, never that the right one was, or that the control
 * should have existed at all.
 *
 * THREE named lists, each pinned in a committed baseline that may only shrink.
 * Writing another bespoke button fails the gate; so does letting a list go
 * stale after a migration. They were counts until a swap — one button
 * deleted, another written — held the total (see identityVerdict). Use
 * `.vm-btn` (src/styles/button-shared.css).
 *
 *   1. BY NAME — button-ish class DEFINITIONS in src/**\/*.css.
 *   2. BY USAGE — classes applied to a `<button>` whose CSS re-derives a button
 *      surface. The name check alone was evadable: `.workspace-approval-approve`
 *      styled a real button and contained neither "btn" nor "button", so it was
 *      never counted and the budget read 88/88 while drift was happening. 61 of
 *      the 80 it finds are invisible to check 1.
 *
 * Not counted (canonical, and legitimately distinct shapes):
 *   - .vm-btn / .vm-btn--*        the primitive itself
 *   - .popup-icon-btn / --*       icon-only square buttons inside popups
 *   - .universal-toolbar-btn      the editor toolbar's own button
 *
 * The usage and shape measurements live in scripts/lib/bespokeButtonUsage.mjs
 * and scripts/lib/bespokeButtonShape.mjs; this file keeps the by-name
 * collector, the list verdict and the CLI.
 *
 * Mirrors scripts/check-file-size.mjs and check-extension-budget.mjs.
 *
 * Usage: node scripts/check-bespoke-buttons.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CSS_RULE_RE, stripComments } from "./lib/cssRules.mjs";
import { isMainModule } from "./lib/isMainModule.mjs";
import { collectStyledButtonClasses } from "./lib/bespokeButtonUsage.mjs";
import { SHAPE_PROPERTIES, buildTokenMap, canonicalTriple, collectShapeDrift } from "./lib/bespokeButtonShape.mjs";

export { collectClassesAppliedToButtons, collectStyledButtonClasses } from "./lib/bespokeButtonUsage.mjs";
export { buildTokenMap, resolveValue, canonicalTriple, collectShapeDrift } from "./lib/bespokeButtonShape.mjs";

const SRC_DIR = "src";
const BASELINE_PATH = "scripts/bespoke-buttons-baseline.json";

const CANONICAL = /^\.(vm-btn|vm-icon-btn|popup-icon-btn|universal-toolbar-btn)(--[a-z0-9-]+)?$/;
/**
 * A class whose NAME looks like a button, anywhere in a selector.
 *
 * This used to anchor at line start, so only the FIRST class of a selector was
 * ever seen and `.tiptap-editor .code-copy-btn` — a real bespoke button — was
 * absent from the budget entirely. Descendant and compound selectors are normal
 * here, so anchoring made the count quietly wrong rather than conservative.
 */
const BUTTON_CLASS_RE = /\.([a-z][a-z0-9_-]*(?:btn|button)[a-z0-9_-]*)/gi;

function walkCss(dir, out = []) {
  return walkExt(dir, ".css", out);
}

/** Every file under `dir` with the given extension, tests excluded. */
function walkExt(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkExt(p, ext, out);
    else if (entry.endsWith(ext) && !entry.includes(".test.")) out.push(p);
  }
  return out;
}

/** Distinct bespoke button class names defined across the given CSS sources. */
export function collectBespokeButtons(files, readFile = (p) => readFileSync(p, "utf8")) {
  const found = new Map(); // class -> file
  for (const file of files) {
    // Selectors only, comments stripped: a class NAMED in a comment is prose,
    // and a declaration value is not a definition.
    for (const rule of stripComments(readFile(file)).matchAll(CSS_RULE_RE)) {
      for (const m of rule[1].matchAll(BUTTON_CLASS_RE)) {
        const cls = `.${m[1]}`;
        if (CANONICAL.test(cls)) continue;
        if (!found.has(cls)) found.set(cls, file);
      }
    }
  }
  return found;
}

/**
 * Every (file, class) definition site, keyed `"<file> <class>"`.
 *
 * The by-name list is keyed by SITE, not by class: a listed name defined in a
 * new file is a new bespoke implementation hiding behind an old exemption, and
 * a class-keyed list let it through (Codex review of the named lists).
 */
export function collectBespokeButtonSites(files, readFile = (p) => readFileSync(p, "utf8")) {
  const sites = new Map(); // "<file> <class>" -> file
  for (const file of files) {
    for (const cls of collectBespokeButtons([file], readFile).keys()) sites.set(`${file} ${cls}`, file);
  }
  return sites;
}

/**
 * Compare the classes the code has against a named list that may only shrink.
 *
 * A COUNT budget read 37/37 after one bespoke button was deleted and another
 * written — a swap is a new bespoke button whatever the total — so each
 * budget is the list of the classes themselves. A class not on the list
 * fails; a listed class the code no longer has is stale and must be deleted,
 * so the win is locked in. One verdict for all three lists: three copies of
 * a two-way ratchet are three places for the "never add" half to be dropped.
 *
 * @returns {{kind: "invalid"|"over"|"stale", message: string} | null}
 */
export function identityVerdict({ key, allowed, found, noun, advice = "", describe = (name, info) => `  ${name}  (${info})` }) {
  const valid =
    Array.isArray(allowed) &&
    allowed.every((c) => typeof c === "string" && c.length > 0) &&
    new Set(allowed).size === allowed.length;
  if (!valid) {
    return { kind: "invalid", message: `❌ ${BASELINE_PATH} needs \`${key}\`: an array of distinct class names.` };
  }
  const listed = new Set(allowed);
  const added = [...found.keys()].filter((c) => !listed.has(c)).sort();
  const stale = allowed.filter((c) => !found.has(c)).sort();
  if (added.length > 0) {
    return {
      kind: "over",
      message:
        `\n❌ ${added.length} new ${noun} (not in \`${key}\`):\n\n` +
        added.map((c) => describe(c, found.get(c))).join("\n") +
        (advice ? `\n\n${advice}` : "") +
        (stale.length > 0 ? `\n\n   (Gone from the code, delete from the list: ${stale.join(", ")}.)` : "") +
        "\n\n   Do NOT add them to the list.\n",
    };
  }
  if (stale.length > 0) {
    return {
      kind: "stale",
      message: `\n❌ \`${key}\` is stale — the code no longer has: ${stale.join(", ")}.\n   Delete them from ${BASELINE_PATH} to lock the win in.\n`,
    };
  }
  return null;
}

// Only run the gate when executed directly, so tests can import the helpers.
if (isMainModule(import.meta.url)) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (error) {
    console.error(`❌ Cannot read ${BASELINE_PATH}: ${error.message}`);
    process.exit(1);
  }

  const found = collectBespokeButtonSites(walkCss(SRC_DIR));
  const nameVerdict = identityVerdict({
    key: "bespokeButtonClasses",
    allowed: baseline.bespokeButtonClasses,
    found,
    describe: (site) => `  ${site}`,
    noun: "bespoke button classes",
    advice:
      "   Use `.vm-btn` from src/styles/button-shared.css, or `.popup-icon-btn`" +
      "\n   for icon-only buttons inside popups.",
  });
  if (nameVerdict) {
    console.error(nameVerdict.message);
    process.exit(1);
  }

  // Second, usage-based budget: classes applied to a <button> whose CSS
  // re-derives a button surface. Naming cannot evade this one.
  const styled = collectStyledButtonClasses(walkExt(SRC_DIR, ".tsx"), walkCss(SRC_DIR));
  const styledVerdict = identityVerdict({
    key: "styledButtonClasses",
    allowed: baseline.styledButtonClasses,
    found: styled,
    noun: "classes that style a <button> without the canonical primitive",
    advice: "   Use `.vm-btn` from src/styles/button-shared.css.",
    describe: (c, file) => `  .${c}  (${file})`,
  });
  if (styledVerdict) {
    console.error(styledVerdict.message);
    process.exit(1);
  }

  // Third, SHAPE: which token each button picked, not merely that it picked one.
  let canonical;
  try {
    canonical = canonicalTriple(readFileSync("src/styles/button-shared.css", "utf8"));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
  const tokens = buildTokenMap(readFileSync("src/styles/index.css", "utf8"));
  const shape = collectShapeDrift(walkExt(SRC_DIR, ".tsx"), walkCss(SRC_DIR), { canonical, tokens });
  const shapeVerdict = identityVerdict({
    key: "shapeDriftClasses",
    allowed: baseline.shapeDriftClasses,
    found: shape,
    noun: "button classes that diverge from the canonical control shape",
    // Report the DIFF, not the name alone: the useful output is "change this
    // to that". A name tells you a rule was broken; this tells you how to fix it.
    describe: (cls, { file, diffs }) =>
      `  .${cls}  (${file})\n` + diffs.map((d) => `      ${d.property}: ${d.actual}  ≠  ${d.expected}`).join("\n"),
    advice:
      "   Canonical is `.vm-btn` (src/styles/button-shared.css): " +
      SHAPE_PROPERTIES.map((p) => `${p} ${canonical[p]}`).join(", ") +
      ".\n   Adopt the primitive, promote a genuinely-missing variant onto it, or — if the" +
      "\n   deviation is justified — record it in the rule body as" +
      "\n   `/* button-shape-ok: <reason> */`. A bare marker with no reason is rejected.",
  });
  if (shapeVerdict) {
    console.error(shapeVerdict.message);
    process.exit(1);
  }

  console.log(
    `✅ Bespoke-button lists held (${found.size} by name, ` +
      `${styled.size} by usage, ${shape.size} by shape — each a named list that only shrinks).`,
  );
}
