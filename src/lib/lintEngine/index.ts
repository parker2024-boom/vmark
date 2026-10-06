/**
 * Markdown lint engine public surface — exports the linter entry point, rule
 * titles and the diagnostic type.
 *
 * @module lib/lintEngine
 */

export { lintMarkdown } from "./linter";
export { ruleTitle } from "./ruleMeta";
export type { LintDiagnostic } from "./types";
