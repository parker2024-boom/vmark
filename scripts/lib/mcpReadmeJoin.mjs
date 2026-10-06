/**
 * Purpose: join `server/mcp/README.md` to the tools the sidecar registers — the
 * README half of the MCP docs gate.
 *
 * The README restates the tool surface in three places a reader trusts: a
 * summary line with the tool and action totals, one table per tool under
 * "Available tools", and the sample `--health-check` output. Nothing compared
 * any of them with the code, and all three drifted apart from it and from each
 * other: the totals stayed at an old surface, the `browser` table kept rows
 * for actions that had moved to `browser_read`, and the health-check sample
 * showed a tool list two tools short.
 *
 * The join is two-way, because the drift was: an action that ships needs a row
 * in its own tool's table, and a row needs an action that tool ships. A stated
 * count must equal the shipped count — in each tool heading (`(N actions)`),
 * in the summary line, and in the health-check sample. A missing summary line,
 * a heading with no count and a README with no "Available tools" section are
 * findings, not passes: a claim the gate cannot find is a claim it cannot hold.
 *
 * What it does not check: the prose in a row. Descriptions drift legitimately;
 * the entry and the numbers are what must be true.
 *
 * @coordinates-with scripts/check-mcp-docs.mjs — the CLI; supplies the shipped actions
 * @coordinates-with server/mcp/README.md — the page this reads
 * @coordinates-with scripts/check-mcp-docs.readme.test.mjs — the self-test
 * @module scripts/lib/mcpReadmeJoin
 */

/**
 * Entry text that WITHDRAWS an action instead of documenting it. Vocabulary,
 * not sentiment: a word here on the entry line makes it a removal notice, and
 * the action still needs an entry of its own.
 */
export const NEGATED =
  /\b(?:no longer|not (?:yet )?(?:supported|available|implemented|shipped)|unsupported|deprecated|removed|retired|dropped|withdrawn|discontinued|obsolete)\b/i;

const TOOLS_HEADING = /^## Available tools\s*$/;
const TOOL_HEADING = /^### `([a-z_]+)`(.*)$/;
const ACTION_ROW = /^\| `([^`]+)` \|/;
const HEADING_COUNT = /\((\d+) actions?\b[^)]*\)/;
const SUMMARY = /\*\*(\d+) tools\*\*, \*\*(\d+) actions\*\*/;

const plural = (n) => `${n} action${n === 1 ? "" : "s"}`;

/** The lines of the "Available tools" section, or null when there is none. */
function toolsSection(lines) {
  const start = lines.findIndex((l) => TOOLS_HEADING.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Per tool, in page order: the counts its headings state and the action rows under them. */
function toolTables(sectionLines) {
  const tables = new Map();
  let current = null;
  for (const line of sectionLines) {
    const heading = TOOL_HEADING.exec(line);
    if (heading) {
      if (!tables.has(heading[1])) tables.set(heading[1], { counts: [], rows: new Set() });
      current = tables.get(heading[1]);
      const count = HEADING_COUNT.exec(heading[2]);
      current.counts.push(count ? Number(count[1]) : null);
    } else if (/^#{1,3} /.test(line)) {
      current = null;
    } else if (current !== null) {
      const row = ACTION_ROW.exec(line);
      if (row && !NEGATED.test(line)) current.rows.add(row[1]);
    }
  }
  return tables;
}

/** Findings for the sample `--health-check` output, when the page carries one. */
function healthSampleFindings(text, toolNames) {
  const findings = [];
  for (const block of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    if (!block[1].includes('"toolCount"')) continue;
    let sample;
    try {
      sample = JSON.parse(block[1]);
    } catch {
      findings.push('the --health-check sample (the JSON block with "toolCount") does not parse');
      continue;
    }
    if (sample.toolCount !== toolNames.length) {
      findings.push(`the --health-check sample shows toolCount ${sample.toolCount}; the sidecar ships ${toolNames.length} tools`);
    }
    const listed = Array.isArray(sample.tools) ? sample.tools : [];
    for (const name of listed) {
      if (!toolNames.includes(name)) findings.push(`the --health-check sample lists \`${name}\`, which is not a shipped tool`);
    }
    for (const name of toolNames) {
      if (!listed.includes(name)) findings.push(`the --health-check sample omits the shipped tool \`${name}\``);
    }
  }
  return findings;
}

/**
 * Every way `readmeText` disagrees with the shipped surface, as sentences.
 *
 * @param {{tool: string, action: string}[]} actions what the sidecar ships
 * @param {string} readmeText the README's text
 * @returns {string[]} empty when the README is true
 */
export function readmeFindings(actions, readmeText) {
  const section = toolsSection(readmeText.split("\n"));
  if (section === null) return ['no "## Available tools" section'];

  const shipped = new Map();
  for (const { tool, action } of actions) {
    if (!shipped.has(tool)) shipped.set(tool, new Set());
    shipped.get(tool).add(action);
  }
  const toolNames = [...shipped.keys()];
  const findings = [];

  const summary = SUMMARY.exec(section.join("\n"));
  if (!summary) {
    findings.push('no summary line of the form "**N tools**, **M actions**" under "Available tools"');
  } else if (Number(summary[1]) !== toolNames.length || Number(summary[2]) !== actions.length) {
    findings.push(
      `the summary line states ${summary[1]} tools and ${summary[2]} actions; the sidecar ships ${toolNames.length} tools and ${actions.length} actions`,
    );
  }

  const tables = toolTables(section);
  for (const [tool, { counts, rows }] of tables) {
    const ships = shipped.get(tool);
    if (!ships) {
      findings.push(`\`${tool}\` has a section but no such tool ships`);
      continue;
    }
    if (counts.includes(null)) {
      findings.push(`\`${tool}\` heading states no action count — write it as "(${plural(ships.size)})"`);
    } else {
      const stated = counts.find((n) => n !== ships.size) ?? counts[0];
      if (stated !== ships.size || rows.size !== ships.size) {
        findings.push(`\`${tool}\` states ${plural(stated)} in its heading but lists ${rows.size} row(s) and the tool ships ${ships.size}`);
      }
    }
    for (const row of rows) {
      if (ships.has(row)) continue;
      const home = toolNames.find((name) => shipped.get(name).has(row));
      findings.push(`\`${tool}\` table lists \`${row}\`, which that tool does not ship${home ? ` (it ships under \`${home}\`)` : ""}`);
    }
    for (const action of ships) {
      if (!rows.has(action)) findings.push(`\`${tool}.${action}\` ships but has no row in the \`${tool}\` table`);
    }
  }
  for (const tool of toolNames) {
    if (!tables.has(tool)) findings.push(`\`${tool}\` ships but has no \`### \`${tool}\`\` section under "Available tools"`);
  }

  return [...findings, ...healthSampleFindings(readmeText, toolNames)];
}
