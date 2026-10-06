/**
 * Untranslated values: locale values byte-identical to English, ratcheted
 * against scripts/i18n-untranslated-baseline.json with the allow-list subtracted.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @coordinates-with scripts/i18nIdenticalAllowlist.ts — the reviewed exemptions
 * @module scripts/i18n-keys/untranslated
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { IDENTICAL_ALLOWLIST, allowedEntries, staleExceptions } from "../i18nIdenticalAllowlist.js";
import { flattenJsonValues, flattenYamlValues } from "./flatten.js";
import { ROOT } from "./paths.js";

// ─── Untranslated values ─────────────────────────────────────────────────────
//
// The checks above prove a key EXISTS in every locale. They cannot tell whether
// anyone translated it: a key copied over with its English value passes, and
// ~1,160 of them once did. This check finds values byte-identical to English
// and ratchets that debt down, in the same shape as
// `scripts/file-size-baseline.json`. The debt is now zero — the baseline is
// empty and must stay that way, so a new entry means a real regression rather
// than one more line in a long list.
//
// The heuristic matters more than the comparison. Of ~3,000 identical pairs,
// most are SUPPOSED to be identical — `JSON`, `YAML`, `CLI`, `Markdown`,
// `TypeScript`, `VMark`. Requiring three words and fifteen characters keeps
// proper nouns, format names and acronyms out while still catching real
// sentences like "Application title bar". It is deliberately conservative:
// a missed untranslated string is a cosmetic bug, whereas a false positive
// would train people to edit the baseline instead of the translation.
//
// A handful survive the heuristic and still cannot be translated — a literal
// path, literal runner labels, a format string with no words. Those go in
// `i18nIdenticalAllowlist.ts` WITH A REASON, not in the baseline: the baseline
// means "not translated yet" and must be able to reach zero. The allow-list is
// checked for staleness in both directions, so translating an exempted string
// forces its dead exemption to be deleted.

const UNTRANSLATED_BASELINE = join(ROOT, "scripts/i18n-untranslated-baseline.json");
const MIN_WORDS = 3;
const MIN_CHARS = 15;

/** Is this value substantial enough that leaving it in English is a real gap? */
function looksTranslatable(value: string): boolean {
  return value.trim().split(/\s+/).length >= MIN_WORDS && value.length >= MIN_CHARS;
}

/**
 * Every value byte-identical to English and substantial enough to matter —
 * BEFORE the allow-list is applied. Staleness detection needs the raw set, so
 * the exemptions are subtracted by the caller rather than skipped here.
 */
function collectIdentical(): string[] {
  const found: string[] = [];

  const enDir = join(ROOT, "src/locales/en");
  if (existsSync(enDir)) {
    const namespaces = readdirSync(enDir).filter((f) => f.endsWith(".json"));
    const langs = readdirSync(join(ROOT, "src/locales"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "en" && d.name !== "__tests__")
      .map((d) => d.name);

    for (const ns of namespaces.sort()) {
      const en = flattenJsonValues(
        JSON.parse(readFileSync(join(enDir, ns), "utf-8")) as unknown
      );
      for (const lang of langs.sort()) {
        const path = join(ROOT, "src/locales", lang, ns);
        if (!existsSync(path)) continue;
        const target = flattenJsonValues(JSON.parse(readFileSync(path, "utf-8")) as unknown);
        for (const [key, value] of en) {
          if (target.get(key) === value && looksTranslatable(value)) {
            found.push(`src/locales/${lang}/${ns}:${key}`);
          }
        }
      }
    }
  }

  const yamlDir = join(ROOT, "src-tauri/locales");
  if (existsSync(join(yamlDir, "en.yml"))) {
    const en = flattenYamlValues(readFileSync(join(yamlDir, "en.yml"), "utf-8"));
    for (const file of readdirSync(yamlDir).filter((f) => f.endsWith(".yml") && f !== "en.yml").sort()) {
      const target = flattenYamlValues(readFileSync(join(yamlDir, file), "utf-8"));
      for (const [key, value] of en) {
        if (target.get(key) === value && looksTranslatable(value)) {
          found.push(`src-tauri/locales/${file}:${key}`);
        }
      }
    }
  }

  return found.sort();
}

export function checkUntranslatedValues(update: boolean): boolean {
  const identical = collectIdentical();
  const identicalSet = new Set(identical);
  const allowed = allowedEntries();
  // Exempted values are not debt; they are the answer. Everything else is.
  const found = identical.filter((e) => !allowed.has(e));
  const stale = staleExceptions(IDENTICAL_ALLOWLIST, identicalSet);

  if (update) {
    writeFileSync(
      UNTRANSLATED_BASELINE,
      `${JSON.stringify({ _comment: BASELINE_COMMENT, minWords: MIN_WORDS, minChars: MIN_CHARS, entries: found }, null, 2)}\n`
    );
    console.log(`\n[UPDATED] ${UNTRANSLATED_BASELINE} — ${found.length} entries`);
    return true;
  }

  if (!existsSync(UNTRANSLATED_BASELINE)) {
    console.error(
      `\n[ERROR] ${UNTRANSLATED_BASELINE} missing — run: pnpm lint:i18n --update-untranslated`
    );
    return false;
  }

  const baseline = new Set<string>(
    (JSON.parse(readFileSync(UNTRANSLATED_BASELINE, "utf-8")) as { entries: string[] }).entries
  );
  const added = found.filter((e) => !baseline.has(e));
  const fixed = [...baseline].filter((e) => !found.includes(e));

  console.log("\nChecking for untranslated values (copied English)...\n");

  if (added.length > 0) {
    console.error(`[ERROR] ${added.length} value(s) left in English:`);
    for (const e of added.slice(0, 20)) console.error(`          ${e}`);
    if (added.length > 20) console.error(`          … and ${added.length - 20} more`);
    console.error("        Translate them. Do not add them to the baseline.");
  }

  if (fixed.length > 0) {
    console.error(`\n[ERROR] ${fixed.length} baselined value(s) now translated — record the win:`);
    console.error("          pnpm lint:i18n --update-untranslated");
  }

  if (stale.length > 0) {
    console.error(
      `\n[ERROR] ${stale.length} allow-list exemption(s) no longer identical to English:`
    );
    for (const e of stale.slice(0, 20)) console.error(`          ${e}`);
    if (stale.length > 20) console.error(`          … and ${stale.length - 20} more`);
    console.error(
      "        Delete them from scripts/i18nIdenticalAllowlist.ts — an exemption that\n" +
        "        no longer applies stops the list describing what is untranslatable."
    );
  }

  if (added.length === 0 && fixed.length === 0 && stale.length === 0) {
    console.log(
      `[OK]    ${found.length} untranslated value(s); ${allowed.size} legitimately identical (allow-listed).`
    );
    return true;
  }
  return false;
}

const BASELINE_COMMENT =
  "Frozen baseline of locale values still identical to English (i.e. never translated). " +
  "scripts/check-i18n-keys.ts fails on any NEW entry, and on a baselined entry that has since " +
  "been translated (record the win by re-running with --update-untranslated). Ratchets down only, " +
  "and is now EMPTY — keep it that way: translate the string, never re-add an entry here. " +
  "A value counts only if it has >= minWords words and >= minChars characters — shorter or " +
  "single-token values (JSON, CLI, Markdown, VMark) are overwhelmingly meant to stay identical. " +
  "Values that can NEVER be translated (a literal path, runner labels, a bare interpolation) do " +
  "not belong here either — they go in scripts/i18nIdenticalAllowlist.ts with a stated reason.";
