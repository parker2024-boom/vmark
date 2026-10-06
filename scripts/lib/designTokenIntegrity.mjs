/**
 * Declaration integrity (C2b–C2g) of the design-token gate, run over
 * the tree: rgb()/hsl() literals and className literals against their identity
 * baseline, duplicate declarations, undeclared keyframes, undefined var()
 * fallbacks, and rule-31 parity. Findings are pushed onto the caller's
 * `violations`; `--update-integrity` rewrites the baseline and exits.
 *
 * @coordinates-with scripts/check-design-tokens.mjs — the CLI
 * @coordinates-with scripts/lib/designTokenChecks.mjs — the per-file checks
 * @coordinates-with scripts/lib/designTokensTsx.mjs — the className scan
 * @module scripts/lib/designTokenIntegrity
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  findColorFnLiterals,
  findDuplicateDeclarations,
  collectKeyframes,
  findMissingKeyframes,
  findUndefinedVarFallbacks,
  rule31Parity,
} from "./designTokenChecks.mjs";
import { findClassNameLiterals } from "./designTokensTsx.mjs";
import { globFiles } from "./designTokenScan.mjs";

/**
 * @param {object} ctx
 * @param {string[]} ctx.args CLI arguments
 * @param {string[]} ctx.files the scanned CSS files
 * @param {boolean} ctx.fixtureMode explicit file arguments, no baseline
 * @param {(file: string) => string | null} ctx.readTree
 * @param {Set<string>} ctx.definedVars custom properties defined anywhere
 * @param {RegExp[]} ctx.colorExclude files whose colour literals are the point
 * @param {object[]} ctx.violations appended to
 */
export function checkDeclarationIntegrity({ args, files, fixtureMode, readTree, definedVars, colorExclude, violations }) {
  const BASELINE_PATH = "scripts/design-tokens-baseline.json";
  const baseline = fixtureMode
    ? { rgbaLiteralDecls: [], classNames: [] }
    : JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  // C2c/C2d/C2e per file; C2b per file against the identity baseline.
  const rgbaFindings = [];
  const declaredKeyframes = new Set();
  for (const file of [...globFiles("src/**/*.css"), ...(fixtureMode ? files : [])]) {
    const keyframeSource = readTree(file);
    if (keyframeSource === null) continue;
    for (const name of collectKeyframes(keyframeSource)) declaredKeyframes.add(name);
  }
  for (const file of files) {
    const content = readTree(file);
    if (content === null) continue;
    if (!colorExclude.some((re) => re.test(file))) {
      rgbaFindings.push(...findColorFnLiterals(content, file));
    }
    for (const dup of findDuplicateDeclarations(content, file)) {
      violations.push({ file, line: 0, check: "duplicate-declaration", value: dup.name, message: dup.message, severity: "error" });
    }
    for (const miss of findMissingKeyframes(content, file, declaredKeyframes)) {
      violations.push({ file, line: miss.line, check: "undeclared-keyframes", value: miss.name, message: miss.message, severity: "error" });
    }
    for (const fb of findUndefinedVarFallbacks(content, file, definedVars)) {
      violations.push({ file, line: fb.line, check: "undefined-var-fallback", value: fb.name, message: fb.message, severity: "error" });
    }
  }

  // C2g — className literals, tree mode only (the TSX surface).
  const classNameFindings = fixtureMode
    ? []
    : globFiles("src/**/*.{ts,tsx}").flatMap((file) => {
        const source = readTree(file);
        return source === null ? [] : findClassNameLiterals(source, file);
      });

  // Identity-baseline comparison for C2b + C2g: new entries and stale
  // entries both fail (house rule — record the win).
  const compare = (name, found, baselined) => {
    const foundIds = new Set(found.map((f) => f.id));
    for (const f of found) {
      if (!baselined.includes(f.id)) {
        violations.push({
          file: f.file,
          line: f.line ?? 0,
          check: name,
          value: f.token ?? f.selector ?? f.id,
          message:
            name === "rgba-literal"
              ? `rgb()/rgba()/hsl() literal. Use a token; if this is a color-mix fallback, put the color-mix on the next line for the same property.`
              : `colour/size/z literal in a className. Use a token-backed class (e.g. ring-[var(--border-color)], z-[var(--z-popup)]).`,
          severity: "error",
        });
      }
    }
    for (const id of baselined) {
      if (!foundIds.has(id)) {
        violations.push({
          file: BASELINE_PATH,
          line: 0,
          check: `${name}-stale`,
          value: id,
          message: `baselined ${name} entry now passes — record the win by removing it from ${BASELINE_PATH}.`,
          severity: "error",
        });
      }
    }
  };
  compare("rgba-literal", rgbaFindings, baseline.rgbaLiteralDecls ?? []);
  if (!fixtureMode) compare("classname-literal", classNameFindings, baseline.classNames ?? []);

  if (args.includes("--update-integrity") && !fixtureMode) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        { ...baseline, rgbaLiteralDecls: rgbaFindings.map((f) => f.id).sort(), classNames: classNameFindings.map((f) => f.id).sort() },
        null,
        2,
      )}\n`,
    );
    console.log(`updated ${BASELINE_PATH}`);
    process.exit(0);
  }

  // C2f — rule-31 parity, tree mode only.
  if (!fixtureMode) {
    const consumedVars = new Set();
    const useRe = /var\(\s*(--[A-Za-z0-9-]+)/g;
    const quotedRe = /["'`](--[A-Za-z0-9-]+)["'`]/g;
    for (const file of [...globFiles("src/**/*.css"), ...globFiles("src/**/*.{ts,tsx}")]) {
      const content = readTree(file);
      if (content === null) continue;
      for (const m of content.matchAll(useRe)) consumedVars.add(m[1]);
      for (const m of content.matchAll(quotedRe)) consumedVars.add(m[1]);
    }
    for (const finding of rule31Parity({
      indexCss: readFileSync("src/styles/index.css", "utf8"),
      ruleMd: readFileSync(".claude/rules/31-design-tokens.md", "utf8"),
      declaredVars: definedVars,
      consumedVars,
    })) {
      violations.push({ file: ".claude/rules/31-design-tokens.md", line: 0, check: "rule31-parity", value: "", message: finding, severity: "error" });
    }
  }
}
