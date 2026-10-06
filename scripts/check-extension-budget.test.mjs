// WI-RA13A.4 — the extension-boundary budget fails on growth, on an unrecorded shrink, and on a budget file that drops half the gate
/**
 * Runs the REAL `scripts/check-extension-budget.mjs` in a scratch tree holding
 * a known-violations list, a budget file and a dependency-cruiser config.
 *
 * Two ceilings are pinned, both two-way:
 *   - `maxKnownViolations` against the length of the known-violations list;
 *   - `maxRuleExemptions` against the `pathNot` entries of each rule.
 * The second is the one that was optional: a budget file without it used to
 * skip the exemption count entirely and still print the success line.
 *
 * @coordinates-with scripts/check-extension-budget.mjs — the gate under test
 * @module scripts/check-extension-budget.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

const violation = (i) => ({ type: "module", from: `src/a${i}.ts`, to: `src/b${i}.ts`, rule: { name: "plugin-isolation" } });
const violations = (n) => Array.from({ length: n }, (_, i) => violation(i));

/** A dependency-cruiser config whose rules carry the given pathNot shapes. */
const cruiser = (forbidden) => `module.exports = ${JSON.stringify({ forbidden })};\n`;

const RULES = [
  { name: "plugin-isolation", from: { path: "^src/plugins", pathNot: ["a", "b"] }, to: { path: "^src/plugins", pathNot: ["c"] } },
  { name: "utils-no-platform", from: { path: "^src/utils", pathNot: "only-one" }, to: { path: "@tauri-apps" } },
  { name: "no-exemptions-here", from: { path: "^src/x" }, to: { path: "^src/y" } },
];
const RULE_BUDGET = { "plugin-isolation": 3, "utils-no-platform": 1 };

function scratch({ known = violations(2), budget = { maxKnownViolations: 2, maxRuleExemptions: RULE_BUDGET }, config = cruiser(RULES) }) {
  const root = mkdtempSync(path.join(tmpdir(), "ext-budget-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  cpSync(path.join(REPO, "scripts/check-extension-budget.mjs"), path.join(root, "scripts/check-extension-budget.mjs"));
  const put = (rel, body) => {
    if (body === null) return;
    writeFileSync(path.join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
  };
  put(".dependency-cruiser-known-violations.json", known);
  put("scripts/extension-budget.json", budget);
  put(".dependency-cruiser.cjs", config);
  return root;
}

function run(root) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-extension-budget.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  return { ...r, out: r.stdout + r.stderr };
}

describe("check-extension-budget.mjs — known-violations ceiling", () => {
  it("exits 0 when both ceilings are met exactly", () => {
    const r = run(scratch({}));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Rule-exemption budget held (4 pathNot entries across 2 rules)");
    expect(r.out).toContain("Extension-boundary budget held (2/2 known violations)");
  });

  it("exits 0 at zero violations with a zero budget", () => {
    const r = run(scratch({ known: [], budget: { maxKnownViolations: 0, maxRuleExemptions: RULE_BUDGET } }));
    expect(r.status, r.out).toBe(0);
  });

  it("one violation over the budget fails", () => {
    const r = run(scratch({ known: violations(3) }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("budget exceeded: 3 known violations, budget is 2");
  });

  it("one violation under the budget fails until the win is recorded", () => {
    const r = run(scratch({ known: violations(1) }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("Budget is stale: only 1 known violations remain but the budget says 2");
  });

  it.each([
    ["a known-violations file that is not an array", { known: { violations: [] } }, "must contain an array"],
    ["a missing known-violations file", { known: null }, "Cannot read known-violations file"],
    ["an unparseable known-violations file", { known: "[ {" }, "Cannot read known-violations file"],
    ["a missing budget file", { budget: null }, "Cannot read budget file"],
    ["a budget with no maxKnownViolations", { budget: { maxRuleExemptions: RULE_BUDGET } }, "needs an integer `maxKnownViolations`"],
    ["a fractional budget", { budget: { maxKnownViolations: 2.5, maxRuleExemptions: RULE_BUDGET } }, "needs an integer"],
    ["a negative budget", { budget: { maxKnownViolations: -1, maxRuleExemptions: RULE_BUDGET } }, "needs an integer"],
    ["a string budget", { budget: { maxKnownViolations: "2", maxRuleExemptions: RULE_BUDGET } }, "needs an integer"],
  ])("%s fails", (_label, opts, message) => {
    const r = run(scratch(opts));
    expect(r.status).toBe(1);
    expect(r.out).toContain(message);
    expect(r.out).not.toContain("budget held");
  });
});

describe("check-extension-budget.mjs — rule-exemption ceiling", () => {
  const withRules = (rules, ruleBudget = RULE_BUDGET) =>
    scratch({ config: cruiser(rules), budget: { maxKnownViolations: 2, maxRuleExemptions: ruleBudget } });

  it("an added pathNot entry fails and names the rule", () => {
    const rules = structuredClone(RULES);
    rules[0].from.pathNot.push("one-more");
    const r = run(withRules(rules));
    expect(r.status).toBe(1);
    expect(r.out).toContain("plugin-isolation: 4 exemptions, budget 3 — an exemption was ADDED");
  });

  it("a string pathNot counts as one exemption, so turning it into two fails", () => {
    const rules = structuredClone(RULES);
    rules[1].from.pathNot = ["only-one", "and-another"];
    const r = run(withRules(rules));
    expect(r.status).toBe(1);
    expect(r.out).toContain("utils-no-platform: 2 exemptions, budget 1");
  });

  it("an exemption on the `to` side counts the same as one on `from`", () => {
    const rules = structuredClone(RULES);
    rules[0].to.pathNot.push("extra-target");
    const r = run(withRules(rules));
    expect(r.status).toBe(1);
    expect(r.out).toContain("plugin-isolation: 4 exemptions, budget 3");
  });

  it("a removed exemption fails until the budget is lowered", () => {
    const rules = structuredClone(RULES);
    rules[0].from.pathNot.pop();
    const r = run(withRules(rules));
    expect(r.status).toBe(1);
    expect(r.out).toContain("plugin-isolation: only 2 exemptions but budget says 3");
  });

  it("a rule that gains its first exemption with no budget entry fails", () => {
    const rules = structuredClone(RULES);
    rules[2].from.pathNot = ["sneaky"];
    const r = run(withRules(rules));
    expect(r.status).toBe(1);
    expect(r.out).toContain("no-exemptions-here: 1 exemptions and NO budget entry");
  });

  it("a budget entry for a rule that no longer exists fails as stale", () => {
    const r = run(withRules(RULES, { ...RULE_BUDGET, "deleted-rule": 2 }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("deleted-rule: only 0 exemptions but budget says 2");
  });

  it("a budget file WITHOUT maxRuleExemptions fails instead of skipping the count", () => {
    const r = run(scratch({ budget: { maxKnownViolations: 2 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("needs a `maxRuleExemptions` object");
    expect(r.out).not.toContain("budget held");
  });

  it.each([
    ["null", null],
    ["an array", [3, 1]],
    ["a number", 4],
  ])("maxRuleExemptions that is %s fails", (_label, value) => {
    const r = run(scratch({ budget: { maxKnownViolations: 2, maxRuleExemptions: value } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("needs a `maxRuleExemptions` object");
  });

  it("a non-integer rule budget fails rather than comparing loosely", () => {
    const r = run(withRules(RULES, { ...RULE_BUDGET, "plugin-isolation": "3" }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("plugin-isolation: budget must be a non-negative integer");
  });

  it("a missing dependency-cruiser config fails", () => {
    const r = run(scratch({ config: null }));
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("budget held");
  });

  it("a config with no `forbidden` array fails rather than counting zero exemptions", () => {
    const r = run(scratch({ config: "module.exports = {};\n", budget: { maxKnownViolations: 2, maxRuleExemptions: {} } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("has no `forbidden` array");
  });
});
