/**
 * Which layer refused an AI browser navigation — one classifier for the SSRF
 * journeys, so the expected refusal is stated per case rather than inferred
 * from one loose regex.
 *
 * TWO LAYERS REFUSE, AND BOTH ARE INTENDED. The MCP sidecar's input schema
 * (`server/mcp/src/tools/browserArgs.ts`, `urlSchema`) rejects any destination
 * that is not `http://` or `https://` before the request leaves the sidecar, so
 * a client's tooling can see the constraint. Everything that IS http(s) reaches
 * the app, where `src-tauri/src/browser/ai_policy.rs` stays authoritative and
 * refuses private, loopback and reserved destinations as `SSRF_BLOCKED`.
 *
 * Journey 29 once matched every refusal against the policy's vocabulary alone.
 * When the schema check landed, the `file:` and `data:` cases began failing at
 * the sidecar, the policy text never appeared, and the journey went red on a
 * correct refusal (issue #1513). Widening the regex to "any error" would let a
 * malformed-argument bug stand in for an SSRF block, which is the exact trap the
 * journey's header warns about. So each case names the layer that must refuse
 * it, and a refusal from any other layer is a failure.
 *
 * @coordinates-with server/mcp/src/tools/browserArgs.ts — the schema message
 * @coordinates-with e2e/journeys/29-browser-ssrf-policy.mjs — the case table
 * @module e2e/lib/browserRefusal
 */

/** The sidecar schema's refusal for a non-HTTP(S) `url` (pinned by the test). */
export const SCHEMA_URL_REFUSAL = "must be an http:// or https:// URL";

/** The app policy's own vocabulary for a refused destination. */
const POLICY_REFUSAL = /SSRF_BLOCKED|blocked|not permitted|refused by policy/i;

/** An MCP input-validation failure (JSON-RPC invalid params) on the `url` field. */
const SCHEMA_URL_FAILURE = new RegExp(
  `-32602[\\s\\S]*Input validation error[\\s\\S]*${escapeRegExp(SCHEMA_URL_REFUSAL)} at url\\b`,
);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Classify a refusal's text.
 *
 * - `"disabled"` — the browser was switched off; proves nothing about policy.
 * - `"schema"` — the sidecar refused a non-HTTP(S) `url` at the input schema.
 * - `"policy"` — the app's navigation policy refused the destination.
 * - `"unrecognised"` — anything else (a crash, a different bad argument, a typo).
 *
 * Disabled is checked first because its text could otherwise be read as a
 * policy word; the schema check is anchored to the `url` field so a validation
 * failure on any other argument is not mistaken for a scheme refusal.
 */
export function refusalLayer(text) {
  const body = String(text ?? "");
  if (/BROWSER_DISABLED/.test(body)) return "disabled";
  if (SCHEMA_URL_FAILURE.test(body)) return "schema";
  if (POLICY_REFUSAL.test(body)) return "policy";
  return "unrecognised";
}
