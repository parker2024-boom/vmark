#!/usr/bin/env node
/**
 * Design Token Enforcement Script
 * Checks CSS files for design system violations, and the
 * declaration-integrity checks C2a–C2g of the UI-consistency plan:
 *
 *   C2a  hardcoded hex — ERROR (was warning; the tree is measured clean
 *        outside the excluded palette files)
 *   C2b  rgb()/rgba()/hsl() literals, with the rgba-before-color-mix
 *        fallback exempted — identity baseline `rgbaLiteralDecls` (per-declaration)
 *   C2c  a custom property declared twice in one :root/.dark-theme block —
 *        zero-tolerance
 *   C2d  every referenced animation-name has a @keyframes — zero-tolerance
 *   C2e  var(--x, fallback) where --x is defined nowhere — zero-tolerance
 *   C2f  rule-31 table rows ⇄ declared tokens, zero-consumer tokens —
 *        zero-tolerance with `token-doc-ok`/`token-unused-ok` reasoned markers
 *   C2g  className strings: hex, Tailwind palette classes, text-[Npx], z-N —
 *        identity baseline `classNames`
 *
 * Baseline: scripts/design-tokens-baseline.json (identity lists, ratchet
 * down only, registered in the ratchet manifest). Fixture mode (explicit file
 * args) runs the per-file checks with no baseline, so a fixture with one
 * violation exits 1.
 *
 * Run: node scripts/check-design-tokens.mjs
 * Part of: pnpm check:all
 */
import { readFileSync } from "node:fs";

import { checkDeclarationIntegrity } from "./lib/designTokenIntegrity.mjs";
import { findFocusRemovals } from "./lib/designTokenFocus.mjs";
import { blankComments, collectJsDefinedVars, globFiles, readScannedFile } from "./lib/designTokenScan.mjs";
import { isMainModule } from "./lib/isMainModule.mjs";

export { findFocusRemovals } from "./lib/designTokenFocus.mjs";
export { blankComments, collectJsDefinedVars, globFiles, readScannedFile } from "./lib/designTokenScan.mjs";

// Main guard: this module EXPORTS collectJsDefinedVars for tests, so importing
// it must not run the checker. Without it the importer's argv leaked in —
// vitest's "run" was treated as a CSS path and the import threw ENOENT.
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const fileArgs = args.filter((a) => !a.startsWith("--"));
  const fixtureMode = fileArgs.length > 0;
  const files = fixtureMode ? fileArgs : globFiles("src/**/*.css");

  // Explicit fixture arguments are claims, not discoveries: a mistyped or
  // missing path must fail LOUD (readFileSync throws here, before any scan),
  // and their contents are captured NOW so even a deletion mid-run cannot
  // demote them to a quiet skip. Only glob-discovered paths get
  // readScannedFile's ENOENT tolerance.
  const fixtureContents = fixtureMode
    ? new Map(files.map((f) => [f, readFileSync(f, "utf8")]))
    : new Map();
  const readTree = (file) => fixtureContents.get(file) ?? readScannedFile(file);

  const violations = [];

  // Files whose colour literals are the point (palettes, print/export
  // overrides, token definitions). editor.css and App.css are no longer
  // listed; the three syntax stylesheets left too — the palette is
  // per-theme catalog data now (ThemeTokens.syntax), the static fallback
  // lives in index.css, and hljs-syntax.css/source-syntax.css are pure role
  // maps onto var(--syntax-*) with zero literals.
  const COLOR_EXCLUDE = [
    /index\.css$/,           // Token definitions
    /alert-block\.css$/,     // GitHub alert colors
    /printStyles\.css$/,     // Print overrides (forces light theme)
    /exportStyles\.css$/,    // Export embeds standalone colors
    /export\/reader\//,      // Self-contained reader bundle (R12, .tokenize/ignore)
  ];

  // Patterns to detect
  const checks = [
    {
      name: "Hardcoded hex color",
      pattern: /(?<!var\([^)]*)(#[0-9a-fA-F]{3,8})(?![^(]*\))/g,
      message: "Use CSS variable token instead",
      severity: "error", // C2a — the tree is measured clean outside COLOR_EXCLUDE
      exclude: COLOR_EXCLUDE,
    },
    {
      name: "Deprecated dark theme selector",
      pattern: /\[data-theme\s*=\s*["']night["']\]/g,
      message: "Use .dark-theme selector instead",
      severity: "error", // This should be fixed
    },
    // "Focus removal without replacement" is NOT a regex check — see
    // findFocusRemovals below. A bare `:focus { outline: none }` pattern
    // flagged four sanctioned caret-only text inputs and nothing else, so it
    // was a pure false-positive generator carrying an "review manually" excuse.
    {
      name: "Non-standard border-radius",
      // Note: 1px and 2px are acceptable for small elements (scrollbars, code spans, cursors)
      pattern: /border-radius:\s*(3px|5px|7px|9px|10px|12px)/g,
      message: "Use standard values: 4px, 6px, 8px, or 100px (pill)",
      severity: "warning", // Normalize gradually
    },
  ];

  for (const file of files) {
    const content = readTree(file);
    if (content === null) continue;

    for (const focus of findFocusRemovals(content)) {
      violations.push({
        file,
        line: focus.line,
        check: "Focus removal without replacement",
        value: focus.selector,
        message:
          "No visible focus indicator. Add a `:focus-visible` rule that paints " +
          "something, or — for a text input where the caret is the indicator — " +
          "a `/* focus: caret-only — <reason> */` marker above the rule.",
        severity: "error", // Now precise enough to block; WCAG is not advisory.
      });
    }

    // Comments are prose, not declarations: scan with them blanked out, and
    // with offsets preserved so line numbers still point at the violation.
    const scannable = blankComments(content);

    for (const check of checks) {
      // Skip excluded files
      if (check.exclude?.some((re) => re.test(file))) continue;

      let match;
      while ((match = check.pattern.exec(scannable)) !== null) {
        // Get line number
        const lines = scannable.slice(0, match.index).split("\n");
        const line = lines.length;

        violations.push({
          file,
          line,
          check: check.name,
          value: match[0].slice(0, 50),
          message: check.message,
          severity: check.severity || "error",
        });
      }
    }
  }



  // ── Undefined CSS custom property check ────────────
  // A var(--x) with no definition anywhere and no fallback is
  // invalid-at-computed-value-time: the declaration silently becomes
  // auto/initial (this shipped a mispositioned, unpadded export control).
  // Tokens written from JS (useTheme/applyTheme) are collected from src too.
  const definedVars = new Set();
  {
    const defRe = /--[A-Za-z0-9-]+(?=\s*:)/g;
    // CSS definitions across all stylesheets (and any fixture files given)
    for (const file of [...globFiles("src/**/*.css"), ...files]) {
      const content = readTree(file);
      if (content === null) continue;
      for (const m of content.matchAll(defRe)) definedVars.add(m[0]);
    }
    // JS-emitted tokens: setProperty("--x", ...) and "--x": value maps
    for (const file of globFiles("src/**/*.{ts,tsx}")) {
      const content = readTree(file);
      if (content === null) continue;
      for (const name of collectJsDefinedVars(content)) definedVars.add(name);
    }
    const useRe = /var\(\s*(--[A-Za-z0-9-]+)\s*\)/g; // no-fallback uses only
    for (const file of files) {
      const content = readTree(file);
      if (content === null) continue;
      for (const m of content.matchAll(useRe)) {
        const name = m[1];
        if (definedVars.has(name)) continue;
        const line = content.slice(0, m.index).split("\n").length;
        violations.push({
          file,
          line,
          check: "undefined-css-var",
          value: m[0],
          message: `var(${name}) has no definition anywhere in src/ and no fallback — the declaration is silently dropped at computed-value time.`,
          severity: "error",
        });
      }
    }
  }

  // ── Declaration integrity (C2b–C2g) ──────────────────────────────────────
  checkDeclarationIntegrity({ args, files, fixtureMode, readTree, definedVars, colorExclude: COLOR_EXCLUDE, violations });


  // Report
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");

  if (warnings.length > 0) {
    console.warn("\n⚠️  Design token warnings:");
    for (const v of warnings) {
      console.warn(`  ${v.file}:${v.line} - ${v.check}`);
      console.warn(`    Found: ${v.value}`);
      console.warn(`    ${v.message}\n`);
    }
  }

  if (errors.length > 0) {
    console.error("\n❌ Design token violations:");
    for (const v of errors) {
      console.error(`  ${v.file}:${v.line} - ${v.check}`);
      console.error(`    Found: ${v.value}`);
      console.error(`    ${v.message}\n`);
    }
    process.exit(1);
  }

  console.log("✅ Design token check passed.");

}

