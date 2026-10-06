/**
 * Key completeness: every locale holds every English key, with the same
 * placeholders and a non-empty value — the JSON namespaces under src/locales/
 * and the Rust YAML locales under src-tauri/locales/.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @coordinates-with scripts/i18nValueChecks.ts — the per-file value checks
 * @module scripts/i18n-keys/keyCompleteness
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { emptyValueIssues, yamlValueIssues } from "../i18nValueChecks.js";
import { flattenJsonValues, flattenYamlValues, loadJsonKeys, loadYamlKeys } from "./flatten.js";
import { ROOT } from "./paths.js";

// ─── Placeholder extraction ─────────────────────────────────────────────────

/** Extract {{placeholder}} names from a translation value. */
function extractPlaceholders(value: string): Set<string> {
  const matches = value.match(/\{\{(\w+)\}\}/g) ?? [];
  return new Set(matches.map((m) => m.replace(/[{}]/g, "")));
}

/** Compare placeholders between source and target JSON files. Returns mismatches. */
function checkPlaceholders(
  sourceFile: string,
  targetFile: string
): string[] {
  const issues: string[] = [];
  try {
    const sourceValues = flattenJsonValues(JSON.parse(readFileSync(sourceFile, "utf-8")));
    const targetValues = flattenJsonValues(JSON.parse(readFileSync(targetFile, "utf-8")));
    for (const [key, sourceVal] of sourceValues) {
      const targetVal = targetValues.get(key);
      if (!targetVal) continue; // Missing key is caught by key check
      const sourcePh = extractPlaceholders(sourceVal);
      const targetPh = extractPlaceholders(targetVal);
      // Check source placeholders exist in target
      for (const ph of sourcePh) {
        if (!targetPh.has(ph)) issues.push(`${key}: missing {{${ph}}}`);
      }
      // Check target doesn't have extra placeholders
      for (const ph of targetPh) {
        if (!sourcePh.has(ph)) issues.push(`${key}: extra {{${ph}}}`);
      }
    }
  } catch {
    // Parse errors caught elsewhere
  }
  return issues;
}

// ─── Comparison ──────────────────────────────────────────────────────────────

interface CheckResult {
  file: string;
  totalExpected: number;
  missing: string[];
  extra: string[];
  placeholderIssues: string[];
}

function compareKeys(
  filePath: string,
  sourceKeys: string[],
  targetKeys: string[],
  placeholderIssues: string[] = []
): CheckResult {
  const sourceSet = new Set(sourceKeys);
  const targetSet = new Set(targetKeys);
  const missing = sourceKeys.filter((k) => !targetSet.has(k));
  const extra = targetKeys.filter((k) => !sourceSet.has(k));
  return { file: filePath, totalExpected: sourceKeys.length, missing, extra, placeholderIssues };
}

function printResult(result: CheckResult): void {
  const rel = result.file.replace(ROOT + "/", "");
  if (result.missing.length === 0 && result.extra.length === 0) {
    console.log(`[OK]    ${rel} — ${result.totalExpected}/${result.totalExpected} keys`);
  } else {
    if (result.missing.length === 0) {
      console.log(`[OK]    ${rel} — ${result.totalExpected}/${result.totalExpected} keys`);
    } else {
      const found = result.totalExpected - result.missing.length;
      console.error(
        `[ERROR] ${rel} — ${found}/${result.totalExpected} keys — ` +
          `${result.missing.length} missing: ${result.missing.join(", ")}`
      );
    }
    if (result.extra.length > 0) {
      const relFile = result.file.replace(ROOT + "/", "");
      console.warn(
        `[WARN]  ${relFile} — ${result.extra.length} extra key${result.extra.length > 1 ? "s" : ""}: ${result.extra.join(", ")}`
      );
    }
    if (result.placeholderIssues.length > 0) {
      const relFile = result.file.replace(ROOT + "/", "");
      console.error(
        `[ERROR] ${relFile} — ${result.placeholderIssues.length} placeholder mismatch${result.placeholderIssues.length > 1 ? "es" : ""}: ${result.placeholderIssues.join("; ")}`
      );
    }
  }
}

// ─── JSON locale check ───────────────────────────────────────────────────────

export function checkJsonLocales(): boolean {
  const localesDir = join(ROOT, "src", "locales");
  if (!existsSync(localesDir)) return true;

  const enDir = join(localesDir, "en");
  if (!existsSync(enDir)) {
    console.warn("[WARN]  src/locales/en/ not found — skipping JSON check");
    return true;
  }

  // Collect all English namespace files
  const enFiles = readdirSync(enDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (enFiles.length === 0) {
    console.log("  No English JSON files found.");
    return true;
  }

  // Build map: namespace → source keys
  const sourceMap = new Map<string, string[]>();
  let legacyPluralFound = false;
  for (const file of enFiles) {
    const keys = loadJsonKeys(join(enDir, file));
    sourceMap.set(file, keys);

    // i18next v4+ resolves plurals via _one/_other; legacy v3 suffixes
    // (_plural, _0) are silently dead — t() falls back to the singular
    // base key for every count.
    const legacy = keys.filter((k) => /_(plural|0)$/.test(k));
    if (legacy.length > 0) {
      console.error(
        `[ERROR] en/${file} — dead legacy plural suffix (use _one/_other): ${legacy.join(", ")}`
      );
      legacyPluralFound = true;
    }
  }
  if (legacyPluralFound) return false;

  // Find other language directories
  const langDirs = readdirSync(localesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "en")
    .map((d) => d.name)
    .sort();

  if (langDirs.length === 0) {
    console.log("  No translation directories found (only English) — nothing to check.");
    return true;
  }

  let allOk = true;

  for (const lang of langDirs) {
    const langDir = join(localesDir, lang);

    // Determine which English files this language has at all
    const presentFiles = enFiles.filter((f) => existsSync(join(langDir, f)));

    if (presentFiles.length === 0) {
      // Completely empty language directory — treat as "not started", skip silently
      console.log(
        `[SKIP]  src/locales/${lang}/ — no files yet (translation not started)`
      );
      continue;
    }

    for (const file of enFiles) {
      const targetPath = join(langDir, file);
      if (!existsSync(targetPath)) {
        // Some files present but this one is missing — that's an error
        const rel = `src/locales/${lang}/${file}`;
        const sourceKeys = sourceMap.get(file)!;
        console.error(
          `[ERROR] ${rel} — MISSING FILE — ${sourceKeys.length} keys absent`
        );
        allOk = false;
        continue;
      }
      const sourceKeys = sourceMap.get(file)!;
      const targetKeys = loadJsonKeys(targetPath);
      const phIssues = checkPlaceholders(join(enDir, file), targetPath);
      const result = compareKeys(targetPath, sourceKeys, targetKeys, phIssues);
      printResult(result);
      // Placeholder mismatches used to fail the run WITHOUT printing — a
      // silent failure (found live when a title-case fixer
      // capitalized inside an interpolation and nothing said why the run was
      // red). Loud, always.
      if (phIssues.length > 0) {
        console.error(`[ERROR] src/locales/${lang}/${file} — ${phIssues.length} placeholder mismatch(es):`);
        for (const issue of phIssues.slice(0, 10)) console.error(`          ${issue}`);
      }
      // A present key with nothing in it renders as nothing. Skipped when the
      // file yielded no keys: an unparseable file is already reported above
      // as missing every key.
      const emptyIssues =
        targetKeys.length > 0
          ? emptyValueIssues(
              JSON.parse(readFileSync(join(enDir, file), "utf-8")) as unknown,
              JSON.parse(readFileSync(targetPath, "utf-8")) as unknown,
            )
          : [];
      if (emptyIssues.length > 0) {
        console.error(`[ERROR] src/locales/${lang}/${file} — ${emptyIssues.length} empty or non-string value(s):`);
        for (const issue of emptyIssues.slice(0, 10)) console.error(`          ${issue}`);
      }
      if (result.missing.length > 0 || phIssues.length > 0 || emptyIssues.length > 0) allOk = false;
    }
  }

  return allOk;
}

// ─── YAML locale check ───────────────────────────────────────────────────────

export function checkYamlLocales(): boolean {
  const tauriLocalesDir = join(ROOT, "src-tauri", "locales");
  if (!existsSync(tauriLocalesDir)) return true;

  const enYml = join(tauriLocalesDir, "en.yml");
  if (!existsSync(enYml)) {
    console.warn("[WARN]  src-tauri/locales/en.yml not found — skipping YAML check");
    return true;
  }

  const sourceKeys = loadYamlKeys(enYml);

  // Find other .yml files (not en.yml)
  const otherYmls = readdirSync(tauriLocalesDir)
    .filter((f) => f.endsWith(".yml") && f !== "en.yml" && !f.startsWith("."))
    .sort();

  if (otherYmls.length === 0) {
    console.log("  No translation YAML files found (only en.yml) — nothing to check.");
    return true;
  }

  let allOk = true;
  const sourceValues = flattenYamlValues(readFileSync(enYml, "utf-8"));

  for (const ymlFile of otherYmls) {
    const targetPath = join(tauriLocalesDir, ymlFile);
    const targetKeys = loadYamlKeys(targetPath);
    const result = compareKeys(targetPath, sourceKeys, targetKeys);
    printResult(result);
    const valueIssues = yamlValueIssues(sourceValues, flattenYamlValues(readFileSync(targetPath, "utf-8")));
    if (valueIssues.length > 0) {
      console.error(`[ERROR] src-tauri/locales/${ymlFile} — ${valueIssues.length} value problem(s):`);
      for (const issue of valueIssues.slice(0, 10)) console.error(`          ${issue}`);
    }
    if (result.missing.length > 0 || valueIssues.length > 0) allOk = false;
  }

  return allOk;
}
