/**
 * Barrel for the GHA workflow parser — re-exports the parser orchestrator.
 *
 * Barrel only — logic lives in the named module so it is visible to
 * coverage (vitest excludes `index.ts` files).
 *
 * @module lib/ghaWorkflow/parser
 */

export * from "./parseWorkflow";
