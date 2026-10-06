/**
 * Readers for the two locale formats: flatten a JSON namespace or a YAML
 * locale into dot-notation keys, or into a key → value map.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @module scripts/i18n-keys/flatten
 */
import { readFileSync } from "node:fs";

/**
 * Flatten a nested JSON object into dot-notation keys.
 * e.g. { a: { b: "v" } } → ["a.b"]
 */
function flattenJson(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [prefix].filter(Boolean);
  }
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      keys.push(...flattenJson(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

/**
 * Parse a flat YAML file (key: "value" or key: value lines).
 * Handles:
 *   - Flat keys:   menu.foo.bar: "value"
 *   - Section heads that are also keys:  menu: "Menu"
 *   - Comment lines and blank lines are skipped
 *   - Indented block-mapping keys (nested YAML) are handled by
 *     tracking the current indent level and building the full path.
 *
 * Returns an array of fully-qualified key strings.
 */
function flattenYaml(content: string): string[] {
  const keys: string[] = [];
  // Stack of { indent, key } to build prefix for nested mappings
  const stack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of content.split("\n")) {
    // Skip comments and blank lines
    const trimmed = rawLine.trimEnd();
    if (!trimmed || /^\s*#/.test(trimmed)) continue;

    // Measure indent
    const indent = trimmed.length - trimmed.trimStart().length;
    const line = trimmed.trimStart();

    // Match a YAML mapping entry: key: [optional value]
    const match = line.match(/^([A-Za-z0-9_.[\]-]+)\s*:(.*)$/);
    if (!match) continue;

    const rawKey = match[1];
    const valuePart = match[2].trim();

    // Pop stack entries that are at same or deeper indent
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    // Build full key from stack prefix + rawKey
    const prefix = stack.map((s) => s.key).join(".");
    const fullKey = prefix ? `${prefix}.${rawKey}` : rawKey;

    if (valuePart === "" || valuePart.startsWith("#")) {
      // Mapping head (no value) — push onto stack for children
      stack.push({ indent, key: rawKey });
    } else {
      // Leaf key — record it
      keys.push(fullKey);
    }
  }

  return keys;
}

/**
 * Flatten a YAML locale to key → value, mirroring `flattenYaml`'s key logic.
 *
 * Separate from `flattenYaml` rather than replacing it because the key check
 * wants every key including mapping heads, while a value check wants leaves
 * only. Quotes are stripped so `"a"` and `a` compare equal — the two locale
 * files do not always agree on quoting style for the same string.
 */
export function flattenYamlValues(content: string): Map<string, string> {
  const values = new Map<string, string>();
  const stack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trimEnd();
    if (!trimmed || /^\s*#/.test(trimmed)) continue;

    const indent = trimmed.length - trimmed.trimStart().length;
    const line = trimmed.trimStart();
    const match = line.match(/^([A-Za-z0-9_.[\]-]+)\s*:(.*)$/);
    if (!match) continue;

    const rawKey = match[1];
    const valuePart = match[2].trim();

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const prefix = stack.map((s) => s.key).join(".");
    const fullKey = prefix ? `${prefix}.${rawKey}` : rawKey;

    if (valuePart === "" || valuePart.startsWith("#")) {
      stack.push({ indent, key: rawKey });
    } else {
      values.set(fullKey, valuePart.replace(/^["']|["']$/g, ""));
    }
  }

  return values;
}

export function loadJsonKeys(filePath: string): string[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return flattenJson(parsed);
  } catch (e) {
    process.stderr.write(
      `  [ERROR] Could not parse ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`
    );
    return [];
  }
}

export function loadYamlKeys(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    return flattenYaml(content);
  } catch (e) {
    process.stderr.write(
      `  [ERROR] Could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`
    );
    return [];
  }
}

/** Flatten a JSON object to key→value string map. */
export function flattenJsonValues(obj: unknown, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    if (prefix && typeof obj === "string") result.set(prefix, obj);
    return result;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      for (const [fk, fv] of flattenJsonValues(v, full)) result.set(fk, fv);
    } else if (typeof v === "string") {
      result.set(full, v);
    }
  }
  return result;
}
