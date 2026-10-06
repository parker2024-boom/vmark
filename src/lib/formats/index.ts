/**
 * Barrel for the format registry — re-exports the format bootstrap entry points.
 *
 * Barrel only — logic lives in the named module so it is visible to
 * coverage (vitest excludes `index.ts` files).
 *
 * @module lib/formats
 */

export * from "./registryBootstrap";
