/**
 * Barrel for the markdown lint rules — re-exports the registered rule list.
 *
 * Barrel only — logic lives in the named module so it is visible to
 * coverage (vitest excludes `index.ts` files).
 *
 * @module lib/lintEngine/rules
 */

export * from "./allRules";
