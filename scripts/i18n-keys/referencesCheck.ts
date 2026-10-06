/**
 * Runs the internal-reference and fragment checks over the locale files and
 * the app source, and reports every finding.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @module scripts/i18n-keys/referencesCheck
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { flattenJsonValues, flattenYamlValues } from "./flatten.js";
import { REGISTERED_FRAGMENTS, fragmentSiteFindings, standaloneTextFindings } from "./fragments.js";
import { fragmentUsageFindings } from "./fragmentUsage.js";
import {
  INTERNAL_REFERENCE_EXCEPTIONS,
  internalReferenceFindings,
  referenceFindingsExcept,
  staleReferenceExceptions,
} from "./internalReferences.js";
import { ROOT } from "./paths.js";

export function checkInternalReferencesAndFragments(): boolean {
  const found: string[] = [];
  const localesDir = join(ROOT, "src", "locales");
  for (const lang of readdirSync(localesDir).filter((d) => !d.startsWith("__"))) {
    const dir = join(localesDir, lang);
    if (!existsSync(dir) || !readdirSync(dir).length) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      for (const [key, value] of flattenJsonValues(JSON.parse(readFileSync(join(dir, file), "utf8")))) {
        const exception = INTERNAL_REFERENCE_EXCEPTIONS[`${file}:${key}`];
        for (const hit of referenceFindingsExcept(value, exception)) found.push(`${lang}/${file}:${key} (${hit}): ${value}`);
      }
    }
  }
  const ymlDir = join(ROOT, "src-tauri", "locales");
  for (const file of readdirSync(ymlDir).filter((f) => f.endsWith(".yml"))) {
    for (const [key, value] of flattenYamlValues(readFileSync(join(ymlDir, file), "utf8"))) {
      for (const hit of internalReferenceFindings(value)) found.push(`${file}:${key} (${hit}): ${value}`);
    }
  }

  const enDir = join(localesDir, "en");
  const wordless: string[] = [];
  for (const file of readdirSync(enDir).filter((f) => f.endsWith(".json"))) {
    const values = Object.fromEntries(
      [...flattenJsonValues(JSON.parse(readFileSync(join(enDir, file), "utf8")))].map(([k, v]) => [`${file}:${k}`, v]),
    );
    wordless.push(...standaloneTextFindings(values, REGISTERED_FRAGMENTS));
  }
  const staleFragments = Object.keys(REGISTERED_FRAGMENTS).filter((id) => {
    const [file, key] = id.split(/:(.*)/s);
    const path = join(enDir, file);
    return !existsSync(path) || !flattenJsonValues(JSON.parse(readFileSync(path, "utf8"))).has(key);
  });

  const enValues: Record<string, string> = {};
  for (const file of readdirSync(enDir).filter((f) => f.endsWith(".json"))) {
    for (const [key, value] of flattenJsonValues(JSON.parse(readFileSync(join(enDir, file), "utf8")))) {
      enValues[`${file}:${key}`] = value;
    }
  }
  const staleExceptionIds = staleReferenceExceptions(enValues, INTERNAL_REFERENCE_EXCEPTIONS);
  const usage: string[] = [];
  const sources: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "locales") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(entry.name)) {
        sources[full.slice(ROOT.length + 1)] = readFileSync(full, "utf8");
      }
    }
  };
  walk(join(ROOT, "src"));
  for (const [rel, text] of Object.entries(sources)) {
    if (rel.endsWith(".tsx")) usage.push(...fragmentUsageFindings(rel, text, REGISTERED_FRAGMENTS));
  }
  const sites = fragmentSiteFindings(sources, REGISTERED_FRAGMENTS);

  for (const f of found) console.error(`[FAIL]  internal reference in UI copy — ${f}`);
  for (const e of staleExceptionIds) console.error(`[FAIL]  INTERNAL_REFERENCE_EXCEPTIONS lists ${e}, which no longer exists or no longer matches — delete the entry`);
  for (const u of usage) console.error(`[FAIL]  ${u} — a fragment is appended to a sentence, never shown by itself`);
  for (const u of sites) console.error(`[FAIL]  ${u} (REGISTERED_FRAGMENTS)`);
  for (const w of wordless) console.error(`[FAIL]  ${w}: no words once placeholders are removed — reword it to stand alone, or register it in REGISTERED_FRAGMENTS with where it appears`);
  for (const s2 of staleFragments) console.error(`[FAIL]  REGISTERED_FRAGMENTS lists ${s2}, which no longer exists — delete the entry`);
  const ok = found.length === 0 && wordless.length === 0 && staleFragments.length === 0 &&
    staleExceptionIds.length === 0 && usage.length === 0 && sites.length === 0;
  if (ok) console.log("[OK]    no internal references in UI copy; every wordless string is a registered fragment");
  return ok;
}
