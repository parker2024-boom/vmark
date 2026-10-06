/**
 * Barrel for the export reader bundle — re-exports readerBundle.
 * Barrel only — logic lives in the named module so it is visible to
 * coverage (vitest excludes every `index.ts`).
 *
 * @module export/reader
 */

export * from "./readerBundle";
