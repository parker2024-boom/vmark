// Regression cover for issue #1513: journey 29 (browser-ssrf-policy) went red on
// macOS because the sidecar's input schema now refuses `file:` and `data:` URLs
// before the app's policy sees them, and the journey recognised only the
// policy's wording. These tests pin the classifier AND tie the journey's case
// table to the sidecar's real schema, so the next drift between the two fails
// here, in the gates tier, instead of in a weekly macOS E2E run.

import { describe, it, expect } from "vitest";
import { refusalLayer, SCHEMA_URL_REFUSAL } from "./browserRefusal.mjs";
import { BLOCKED } from "../journeys/29-browser-ssrf-policy.mjs";
import { isNavigableUrl, urlSchema } from "../../server/mcp/src/tools/browserArgs.ts";

// Verbatim from the failing run (37278239310), so the classifier is checked
// against what the MCP SDK actually emits, not a paraphrase of it.
const OBSERVED_SCHEMA_REFUSAL =
  "MCP error -32602: Input validation error: Invalid arguments for tool browser: " +
  "must be an http:// or https:// URL at url";

// The bridge's rendering of the Rust `blocked_destination()` error
// (src/services/mcpBridge/v2/__tests__/browserNavigation.test.ts).
const POLICY_REFUSAL_TEXT = "SSRF_BLOCKED: AI navigation to this destination is blocked by policy";

describe("refusalLayer", () => {
  it("classifies the sidecar's non-HTTP(S) schema refusal as schema", () => {
    expect(refusalLayer(OBSERVED_SCHEMA_REFUSAL)).toBe("schema");
  });

  it("classifies the app policy's SSRF refusal as policy", () => {
    expect(refusalLayer(POLICY_REFUSAL_TEXT)).toBe("policy");
  });

  it("classifies a disabled browser as disabled, even if policy words appear", () => {
    expect(refusalLayer("BROWSER_DISABLED: the browser is blocked in settings")).toBe("disabled");
  });

  it("does not accept a schema failure on a different field as a URL refusal", () => {
    const other =
      "MCP error -32602: Input validation error: Invalid arguments for tool browser: " +
      "timeoutMs must be an integer from 1 to 60000 at timeoutMs";
    expect(refusalLayer(other)).toBe("unrecognised");
  });

  it("does not accept the URL message without the invalid-params code", () => {
    expect(refusalLayer(`Error: ${SCHEMA_URL_REFUSAL} at url`)).toBe("unrecognised");
  });

  it.each(["", undefined, null, "Error: connection reset", "invalid URL"])(
    "reports %j as unrecognised",
    (text) => {
      expect(refusalLayer(text)).toBe("unrecognised");
    },
  );
});

describe("journey 29's case table agrees with the sidecar schema", () => {
  it("uses the sidecar's own refusal message", () => {
    const result = urlSchema("x").safeParse("file:///etc/passwd");
    expect(result.success).toBe(false);
    expect(result.error.issues.map((i) => i.message)).toEqual([SCHEMA_URL_REFUSAL]);
  });

  it("covers both layers", () => {
    const layers = new Set(BLOCKED.map(([, , layer]) => layer));
    expect([...layers].sort()).toEqual(["policy", "schema"]);
  });

  // A "policy" case the schema refuses would never reach ai_policy.rs, so it
  // would test nothing about the policy; a "schema" case the schema accepts
  // would reach the app and fail the journey. Either drift fails here first.
  it.each(BLOCKED)("%s (%s) is expected at the %s layer", (_label, url, layer) => {
    expect(["policy", "schema"]).toContain(layer);
    expect(isNavigableUrl(url)).toBe(layer === "policy");
  });
});
