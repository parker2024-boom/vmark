/**
 * Purpose: value-level checks for a translation that HAS every key — the gap
 *   between "the key exists" and "something correct would render".
 *
 * The key-completeness check proves presence, and the untranslated check
 * catches a value copied over in English. Neither sees a key whose value is
 * empty: `"save": ""` is present, is not identical to English, and renders as
 * nothing. Nor did anything compare `%{name}` interpolations in the Rust YAML
 * bundles, where a dropped placeholder silently loses the value it carried.
 *
 * Pure over already-parsed data, so the gate decides how a file that does not
 * parse is reported and these functions never see one.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — calls these per locale file
 * @coordinates-with scripts/check-i18n-keys.test.mjs — pins them through the real gate
 * @module scripts/i18nValueChecks
 */

/** Leaf values of a (possibly nested) locale object, keyed by dotted path. */
function leaves(obj: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) leaves(value, full, out);
    else out.set(full, value);
  }
  return out;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Keys the translation carries with nothing renderable in them.
 *
 * Only keys whose ENGLISH value is real text are judged, so an English string
 * that is deliberately empty does not force a translation to invent one. A
 * key absent from the translation is the completeness check's finding, not
 * this one's.
 */
export function emptyValueIssues(source: unknown, target: unknown): string[] {
  const translated = leaves(target);
  const issues: string[] = [];
  for (const [key, english] of leaves(source)) {
    if (!isText(english) || !translated.has(key)) continue;
    if (!isText(translated.get(key))) issues.push(`${key}: empty or non-string value`);
  }
  return issues;
}

/** The `%{name}` interpolations rust-i18n substitutes into a value. */
function yamlPlaceholders(value: string): Set<string> {
  return new Set(value.match(/%\{\w+\}/g) ?? []);
}

/**
 * Empty values and `%{name}` mismatches in a YAML translation, against English.
 *
 * Both directions matter: a missing placeholder drops the value it carried,
 * and an invented one is printed literally.
 */
export function yamlValueIssues(
  source: ReadonlyMap<string, string>,
  target: ReadonlyMap<string, string>,
): string[] {
  const issues: string[] = [];
  for (const [key, english] of source) {
    const translated = target.get(key);
    if (translated === undefined || english.trim() === "") continue;
    if (translated.trim() === "") {
      issues.push(`${key}: empty value`);
      continue;
    }
    const expected = yamlPlaceholders(english);
    const found = yamlPlaceholders(translated);
    for (const placeholder of expected) {
      if (!found.has(placeholder)) issues.push(`${key}: missing ${placeholder}`);
    }
    for (const placeholder of found) {
      if (!expected.has(placeholder)) issues.push(`${key}: extra ${placeholder}`);
    }
  }
  return issues;
}
