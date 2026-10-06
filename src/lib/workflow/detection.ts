/**
 * Is this YAML a VMark engine workflow? (WI-LX2.1)
 *
 * Purpose: the yaml adapter routes every `.yml`/`.yaml` file, and two
 * unrelated features want some of them. The rule that tells them apart:
 *
 * | Check (in order) | GitHub Actions workflow | VMark engine workflow |
 * |---|---|---|
 * | Path under `.github/workflows/` | always — GitHub owns it | never |
 * | Top-level `jobs:` | yes | never (the schema has no jobs) |
 * | Top-level `steps:` whose `uses:` names `genie/`, `action/` or `webhook/` | never (steps live under a job) | yes |
 *
 * Both may carry `on:`, so `on:` decides nothing. A file with top-level
 * `steps:` AND `jobs:` is not claimed here: ambiguity goes to the read-only
 * viewer, never to the runner. The `uses:` prefix is what keeps look-alikes
 * out — an Azure Pipelines file has top-level `steps:` too, but its steps are
 * `script:`/`task:`, and a GitHub reference is `owner/repo@ref`.
 *
 * It reads the PARSED document, never text: only a `uses:`
 * that is a step's own key counts — never one under another top-level key, a
 * step's `with:`, a flow value or a block scalar — and every sequence form the
 * workflow parser accepts (indented, indentationless, flow) is recognised.
 * Malformed YAML is NEVER an engine workflow (round 2): a line scan of broken
 * YAML cannot tell a step's own `uses:` from a nested one, so claiming it
 * offered Run on a guess. The plain tree shows the parse error instead, and a
 * LIVE run whose file stops parsing keeps its Cancel through the yaml
 * adapter's generic preview. This is the ONE engine-workflow rule:
 * `parser.ts:isWorkflowYaml` delegates here rather than keeping a second one.
 *
 * @coordinates-with lib/formats/adapters/yaml.tsx — the schema detector that calls it
 * @coordinates-with lib/ghaWorkflow/detection.ts — the GitHub Actions half of the rule
 * @module lib/workflow/detection
 */

import { parse as parseYaml } from "yaml";
import { looksLikeWorkflowPath } from "@/lib/ghaWorkflow/detection";

const TOP_LEVEL_STEPS = /^steps\s*:/m;
/** A `uses` value naming a VMark step type. */
const ENGINE_USES_VALUE = /^(?:genie|action|webhook)\//;

export function isEngineWorkflow(path: string | null | undefined, content: string): boolean {
  if (looksLikeWorkflowPath(path)) return false;
  // Cheap text pre-filter: no top-level `steps:` or no engine prefix anywhere
  // means no parse is needed to say no.
  if (!content || !TOP_LEVEL_STEPS.test(content) || !/(?:genie|action|webhook)\//.test(content)) {
    return false;
  }
  try {
    return hasEngineSteps(parseYaml(content));
  } catch {
    return false; // malformed: never an engine workflow
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level `steps` is a list with a step whose own `uses` is an engine type, and no `jobs`. */
function hasEngineSteps(doc: unknown): boolean {
  if (!isRecord(doc) || "jobs" in doc || !Array.isArray(doc.steps)) return false;
  return doc.steps.some(
    (step) => isRecord(step) && typeof step.uses === "string" && ENGINE_USES_VALUE.test(step.uses),
  );
}
