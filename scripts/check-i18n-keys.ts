#!/usr/bin/env -S node --import tsx
/**
 * I18n Key Completeness Check
 * Verifies all language files have the same keys as the English source.
 *
 * Usage: npx tsx scripts/check-i18n-keys.ts
 * Part of: pnpm check:all
 *
 * Checks:
 *   - src/locales/{lang}/*.json  vs  src/locales/en/*.json  (every namespace)
 *   - src-tauri/locales/{lang}.yml  vs  src-tauri/locales/en.yml
 *
 * A key that is present must also hold something: an empty or non-string
 * value fails, and so does a YAML translation whose `%{name}` placeholders
 * differ from English (scripts/i18nValueChecks.ts).
 *
 * Exit codes:
 *   0  All good (or no translations to check)
 *   1  One or more checks failed: missing keys, placeholder or value problems,
 *      untranslated values, dialog literals, copy conventions, fragments
 *
 * The checks live one per module in scripts/i18n-keys/; this file is the CLI
 * that runs them in order and re-exports what the self-tests import.
 *
 * @coordinates-with scripts/i18n-keys/keyCompleteness.ts — keys, placeholders and empty values
 * @coordinates-with scripts/i18n-keys/untranslated.ts — values left in English
 * @coordinates-with scripts/i18n-keys/dialogLiterals.ts — hardcoded dialog and toast copy
 * @coordinates-with scripts/i18n-keys/copyConventions.ts — casing and punctuation
 * @coordinates-with scripts/i18n-keys/referencesCheck.ts — internal references and fragments
 * @coordinates-with scripts/check-i18n-keys.test.mjs — runs this whole script against a scratch tree
 */

import { checkCopyConventions } from "./i18n-keys/copyConventions.js";
import { checkDialogLiterals } from "./i18n-keys/dialogLiterals.js";
import { checkJsonLocales, checkYamlLocales } from "./i18n-keys/keyCompleteness.js";
import { checkInternalReferencesAndFragments } from "./i18n-keys/referencesCheck.js";
import { checkUntranslatedValues } from "./i18n-keys/untranslated.js";
import { isMainModule } from "./lib/isMainModule.mjs";

export {
  checkCopyConventions,
  emdashSpacingViolation,
  titleCaseViolations,
  titleRegister,
} from "./i18n-keys/copyConventions.js";
export { dialogLiteralFindings } from "./i18n-keys/dialogLiterals.js";
export {
  REGISTERED_FRAGMENTS,
  fragmentSiteFindings,
  standaloneTextFindings,
  type FragmentRegistration,
} from "./i18n-keys/fragments.js";
export { fragmentUsageFindings } from "./i18n-keys/fragmentUsage.js";
export {
  INTERNAL_REFERENCE_EXCEPTIONS,
  internalReferenceFindings,
  referenceFindingsExcept,
  staleReferenceExceptions,
  type ReferenceException,
} from "./i18n-keys/internalReferences.js";

// ─── Main ─────────────────────────────────────────────────────────────────────
// Guarded so the classifier can be imported by its test without running the
// whole gate (scripts/lib/isMainModule.mjs, which every gate shares).

if (isMainModule(import.meta.url)) {
  console.log("Checking i18n key completeness...\n");

  const updateUntranslated = process.argv.includes("--update-untranslated");
  const updateCopy = process.argv.includes("--update-copy");

  const jsonOk = checkJsonLocales();
  const yamlOk = checkYamlLocales();
  const valuesOk = checkUntranslatedValues(updateUntranslated);
  const dialogsOk = checkDialogLiterals();
  const copyOk = checkCopyConventions(updateCopy);
  const referencesOk = checkInternalReferencesAndFragments();

  if (jsonOk && yamlOk && valuesOk && dialogsOk && copyOk && referencesOk) {
    console.log("\nAll i18n checks passed.");
    process.exit(0);
  } else {
    console.error("\ni18n check FAILED.");
    process.exit(1);
  }
}
