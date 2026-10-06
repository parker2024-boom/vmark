// WI-RA15A.7 — the sidecar README's tool and action tables are joined to the shipped tool surface.
/**
 * Self-test of the README half of the MCP docs gate.
 *
 * @coordinates-with scripts/lib/mcpReadmeJoin.mjs — the join under test
 * @coordinates-with scripts/check-mcp-docs.mjs — the CLI that runs it
 * @module scripts/check-mcp-docs.readme.test
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shippedActions } from "./check-mcp-docs.mjs";
import { readmeFindings } from "./lib/mcpReadmeJoin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHIPPED = [
  { file: "browser.ts", tool: "browser", action: "act" },
  { file: "browser.ts", tool: "browser", action: "open" },
  { file: "browserRead.ts", tool: "browser_read", action: "read" },
];

const section = (tool, count, rows) =>
  `### \`${tool}\` — something (${count})\n\n| Action | Purpose |\n|---|---|\n${rows.map((r) => `| \`${r}\` | does it |`).join("\n")}\n`;

/** A README whose tables match SHIPPED unless a part is overridden. */
function readme({
  summary = "**2 tools**, **3 actions**.",
  browser = section("browser", "2 actions", ["act", "open"]),
  browserRead = section("browser_read", "1 action", ["read"]),
  health = '```json\n{ "status": "ok", "toolCount": 2, "tools": ["browser", "browser_read"] }\n```\n',
  extra = "",
} = {}) {
  return `# pkg\n\n## CLI\n\n${health}\n## Available tools\n\n${summary}\n\n${browser}\n${browserRead}\n${extra}## Structured output\n\n| \`ghost\` | a table outside the tools section is not an action row |\n`;
}

describe("readmeFindings — the sidecar README against the shipped surface", () => {
  it("is clean when every tool, action and count matches", () => {
    expect(readmeFindings(SHIPPED, readme())).toEqual([]);
  });

  it("reports a shipped action with no row in its own tool's section", () => {
    const text = readme({ browser: section("browser", "2 actions", ["act"]) });
    expect(readmeFindings(SHIPPED, text)).toEqual([
      "`browser` states 2 actions in its heading but lists 1 row(s) and the tool ships 2",
      "`browser.open` ships but has no row in the `browser` table",
    ]);
  });

  it("reports a row for an action the tool does not ship — the stale-table case", () => {
    const text = readme({ browser: section("browser", "3 actions", ["act", "open", "read"]) });
    const found = readmeFindings(SHIPPED, text);
    expect(found).toContain("`browser` table lists `read`, which that tool does not ship (it ships under `browser_read`)");
    expect(found).toContain("`browser` states 3 actions in its heading but lists 3 row(s) and the tool ships 2");
  });

  it("reports a row for an action nothing ships", () => {
    const text = readme({ browserRead: section("browser_read", "2 actions", ["read", "resolve"]) });
    expect(readmeFindings(SHIPPED, text)).toContain("`browser_read` table lists `resolve`, which that tool does not ship");
  });

  it("reports a section for a tool that is not shipped, and a shipped tool with no section", () => {
    const text = readme({ browserRead: section("coherence", "1 action", ["read"]) });
    const found = readmeFindings(SHIPPED, text);
    expect(found).toContain("`coherence` has a section but no such tool ships");
    expect(found).toContain("`browser_read` ships but has no `### `browser_read`` section under \"Available tools\"");
  });

  it("requires each tool heading to state its action count, and checks it", () => {
    expect(readmeFindings(SHIPPED, readme({ browser: section("browser", "embedded browser", ["act", "open"]) }))).toEqual([
      "`browser` heading states no action count — write it as \"(2 actions)\"",
    ]);
    expect(readmeFindings(SHIPPED, readme({ browser: section("browser", "13 actions", ["act", "open"]) }))).toEqual([
      "`browser` states 13 actions in its heading but lists 2 row(s) and the tool ships 2",
    ]);
  });

  it("checks the summary line's tool and action totals, and fails closed when it is missing", () => {
    expect(readmeFindings(SHIPPED, readme({ summary: "**7 tools**, **34 actions**." }))).toEqual([
      "the summary line states 7 tools and 34 actions; the sidecar ships 2 tools and 3 actions",
    ]);
    expect(readmeFindings(SHIPPED, readme({ summary: "Seven composite tools." }))).toEqual([
      "no summary line of the form \"**N tools**, **M actions**\" under \"Available tools\"",
    ]);
  });

  it("checks the --health-check sample's tool count and tool names", () => {
    const stale = '```json\n{ "status": "ok", "toolCount": 7, "tools": ["browser", "coherence"] }\n```\n';
    expect(readmeFindings(SHIPPED, readme({ health: stale }))).toEqual([
      "the --health-check sample shows toolCount 7; the sidecar ships 2 tools",
      "the --health-check sample lists `coherence`, which is not a shipped tool",
      "the --health-check sample omits the shipped tool `browser_read`",
    ]);
    // A README with no sample has nothing to drift.
    expect(readmeFindings(SHIPPED, readme({ health: "" }))).toEqual([]);
  });

  it("reports a health-check sample that is not valid JSON instead of skipping it", () => {
    const broken = '```json\n{ "toolCount": 2, "tools": [browser] }\n```\n';
    expect(readmeFindings(SHIPPED, readme({ health: broken }))).toEqual([
      "the --health-check sample (the JSON block with \"toolCount\") does not parse",
    ]);
  });

  it("does not count a row that withdraws the action as documenting it", () => {
    const text = readme({ browser: `${section("browser", "2 actions", ["act"])}| \`open\` | removed in 0.9 |\n` });
    expect(readmeFindings(SHIPPED, text)).toContain("`browser.open` ships but has no row in the `browser` table");
  });

  it("fails closed on a README with no \"Available tools\" section, and on empty input", () => {
    expect(readmeFindings(SHIPPED, "# pkg\n\n## Usage\n")).toEqual(["no \"## Available tools\" section"]);
    expect(readmeFindings(SHIPPED, "")).toEqual(["no \"## Available tools\" section"]);
  });

  it("keeps both halves when a tool has two sections", () => {
    const text = readme({ browser: section("browser", "2 actions", ["act"]), extra: section("browser", "2 actions", ["open"]) });
    expect(readmeFindings(SHIPPED, text)).toEqual([]);
  });
});

describe("the shipped README", () => {
  it("server/mcp/README.md matches the tools the sidecar registers", () => {
    const text = readFileSync(path.join(ROOT, "server/mcp/README.md"), "utf8");
    expect(readmeFindings(shippedActions(), text)).toEqual([]);
  });
});
