/**
 * Workspace facade — ADR-008.
 *
 * `useWorkspace()`, the aggregate read API this facade was created for, was
 * never adopted (zero production importers) and was deleted under the
 * feature-ledger plan. What remains is the one export quick-open
 * consumes.
 *
 * @module workspace
 */

export { useActiveWorkspaceScope } from "@/hooks/useActiveWorkspaceScope";
