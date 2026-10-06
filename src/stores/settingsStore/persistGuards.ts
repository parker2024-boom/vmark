/**
 * Settings persist-boundary guards
 *
 * Purpose: Zero-trust validation of persisted settings before they are deep-
 * merged into live state. Drops persisted branches AND leaves whose shape/type
 * doesn't match the live defaults, so a corrupt localStorage blob can't replace
 * a settings object with a primitive, smuggle a stringified number, or swap an
 * array for a scalar. Split out of settingsStore.ts to keep that file near the
 * ~300-line guideline.
 *
 * @coordinates-with settingsStore.ts — runs in the persist `merge` hook
 * @coordinates-with src/utils/deepMerge.ts — deepMerge runs on the sanitized blob
 * @module stores/settingsStore/persistGuards
 */

import type { SettingsState } from "../settingsTypes";

/** Runtime type names a nullable settings leaf may declare. */
type NullableLeafType = "number" | "string";

/** `"section.key"` for every settings leaf whose declared type admits `null`. */
type NullableLeafPath = {
  [S in keyof SettingsState & string]: SettingsState[S] extends object
    ? {
        [K in keyof SettingsState[S] & string]: null extends SettingsState[S][K]
          ? `${S}.${K}`
          : never;
      }[keyof SettingsState[S] & string]
    : never;
}[keyof SettingsState & string];

/**
 * The non-null type of each nullable setting. A `null` default carries no type
 * of its own, so without this table any persisted value passed for it. The
 * key type is derived from `SettingsState`, so adding a nullable field to the
 * settings types without declaring it here is a compile error.
 */
export const NULLABLE_LEAF_TYPES: Readonly<Record<NullableLeafPath, NullableLeafType>> = {
  "update.lastCheckTimestamp": "number",
  "update.skipVersion": "string",
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Drop persisted branches AND leaves whose shape/type doesn't match the live
 * defaults (T4, persist-boundary zero-trust).
 *
 * Object branches: wherever the default is a plain object, the persisted value
 * must also be a plain object — otherwise deepMerge (which only recurses when
 * both sides are objects) would overwrite that object with a primitive/array
 * and crash consumers. Mismatches are skipped so the live default survives.
 * Recurses into nested object branches, so corruption at any depth is caught.
 *
 * Leaf values (primitives, arrays): the persisted type must match the default's
 * type, otherwise it is dropped so the live default survives. This rejects
 * corrupt values such as `appearance.fontSize: "999"` (string for number) or
 * `advanced.customLinkProtocols: "obsidian"` (string for array). Number leaves
 * additionally require a finite value (NaN/Infinity are dropped — range clamping
 * happens later and assumes finiteness).
 *
 * Special cases:
 *   - A `null` default marks a nullable field like `update.lastCheckTimestamp`.
 *     It accepts `null` or the type declared in NULLABLE_LEAF_TYPES; a null
 *     default with no declared type accepts only `null` (fail closed).
 *   - Keys absent from the defaults pass through unchanged (forward
 *     compatibility) — they are unknown to the typed store and harmless.
 *
 * Exported for testing.
 */
export function sanitizePersistedSettings(
  persisted: Record<string, unknown>,
  defaults: Record<string, unknown>
): Record<string, unknown> {
  return sanitizeBranch(persisted, defaults, "");
}

function sanitizeBranch(
  persisted: Record<string, unknown>,
  defaults: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(persisted)) {
    const def = defaults[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(def)) {
      if (!isPlainObject(value)) continue; // shape mismatch — preserve the default
      clean[key] = sanitizeBranch(value, def, path); // recurse into nested branch
    } else if (key in defaults) {
      if (!persistedLeafMatchesDefault(value, def, path)) continue; // type mismatch — preserve the default
      clean[key] = value;
    } else {
      clean[key] = value; // unknown key — forward compatibility
    }
  }
  return clean;
}

/** Normalize persisted enum-like browser posture values to the safest mode. */
export function normalizeBrowserSettings(browser: Record<string, unknown>): void {
  if (browser.aiSession !== "sandbox" && browser.aiSession !== "shared") {
    browser.aiSession = "sandbox";
  }
  if (typeof browser.aiAllowLoopback !== "boolean") {
    browser.aiAllowLoopback = false;
  }
}

/**
 * True when a persisted leaf value is type-compatible with its default. The
 * default's runtime type is the contract; arrays and `null` are handled
 * explicitly because `typeof` reports both as `"object"`. A `null` default
 * takes its type from NULLABLE_LEAF_TYPES.
 */
function persistedLeafMatchesDefault(value: unknown, def: unknown, path: string): boolean {
  if (def === null) {
    if (value === null) return true;
    const declared: NullableLeafType | undefined =
      (NULLABLE_LEAF_TYPES as Readonly<Record<string, NullableLeafType>>)[path];
    return declared !== undefined && leafHasType(value, declared);
  }
  if (Array.isArray(def)) return Array.isArray(value);
  if (typeof def === "number") return leafHasType(value, "number");
  return typeof value === typeof def;
}

/** Numbers must also be finite: range clamping later assumes finiteness. */
function leafHasType(value: unknown, type: NullableLeafType): boolean {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string";
}
