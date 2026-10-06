/**
 * The bespoke-button gate's USAGE measurement: which classes a literal
 * `<button>` carries in TSX, and which of those re-derive a button surface in
 * CSS. Pure functions; files are read through the injected `readFile`.
 *
 * @coordinates-with scripts/check-bespoke-buttons.mjs — the CLI, which re-exports these
 * @coordinates-with scripts/lib/bespokeButtonShape.mjs — the shape measurement, same `<button>` reading
 * @coordinates-with scripts/lib/cssRules.mjs — the one CSS grammar
 * @module scripts/lib/bespokeButtonUsage
 */
import { readFileSync } from "node:fs";
import { CSS_RULE_RE } from "./cssRules.mjs";

/** Classes applied to a literal `<button>` element in TSX. */
const BUTTON_EL_RE =
  /<button\b[^>]*?className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/gs;
/** Canonical names as they appear in JSX (no leading dot). */
export const CANONICAL_BARE = /^(vm-btn|vm-icon-btn|popup-icon-btn|universal-toolbar-btn)(--[a-z0-9-]+)?$/;

/**
 * Does this rule body re-derive a button SURFACE (rather than just position or
 * colour something)? Padding plus a border or background is the shape every
 * hand-rolled button in this repo had.
 */
function stylesButtonSurface(body) {
  return /(?:^|[;{\s])padding\b/.test(body) && /(?:^|[;{\s])(?:border|background)\b/.test(body);
}

/**
 * Every class applied to a literal `<button>`, mapped to the first file that
 * applies it. Shared by both usage-based collectors — they had the same loop
 * twice, which meant a change to the supported JSX syntax could improve one
 * measurement and silently leave the other behind.
 */
export function collectClassesAppliedToButtons(tsxFiles, readFile = (p) => readFileSync(p, "utf8")) {
  const appliedToButton = new Map();
  for (const file of tsxFiles) {
    for (const m of readFile(file).matchAll(BUTTON_EL_RE)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? "";
      for (const cls of raw.match(/[a-zA-Z_][\w-]*/g) ?? []) {
        if (!appliedToButton.has(cls)) appliedToButton.set(cls, file);
      }
    }
  }
  return appliedToButton;
}

/**
 * Bespoke button classes found by USAGE rather than by name.
 *
 * The name-based collector in the CLI only sees classes containing "btn"/"button",
 * so `.workspace-approval-approve` — which styled a real button with its own
 * padding, radius and border — was invisible to the budget. This keys on the
 * pairing that actually defines the problem: a class applied to a `<button>`
 * whose CSS re-derives a button surface. A class cannot evade it by naming.
 *
 * Known limits, deliberate: only literal `className` strings and template
 * literals are read (not `clsx()`/computed names), and only literal `<button>`
 * elements (not components that render one). It under-counts rather than
 * inventing violations.
 */
export function collectStyledButtonClasses(
  tsxFiles,
  cssFiles,
  readFile = (p) => readFileSync(p, "utf8"),
) {
  const appliedToButton = collectClassesAppliedToButtons(tsxFiles, readFile);

  const bodyByClass = new Map(); // class -> concatenated declarations
  for (const file of cssFiles) {
    for (const rule of readFile(file).matchAll(CSS_RULE_RE)) {
      for (const cls of rule[1].matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
        bodyByClass.set(cls[1], (bodyByClass.get(cls[1]) ?? "") + rule[2]);
      }
    }
  }

  const found = new Map();
  for (const [cls, file] of appliedToButton) {
    if (CANONICAL_BARE.test(cls)) continue;
    const body = bodyByClass.get(cls);
    if (body && stylesButtonSurface(body)) found.set(cls, file);
  }
  return found;
}
