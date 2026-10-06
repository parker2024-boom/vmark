/**
 * Doc join `lint-table`: `website/guide/lint.md` ↔ the lint engine.
 *
 * Two things the page states are restatements of code, and both had drifted
 * through every green CI run — a docs-only PR runs no test that reads the rules:
 *
 *   1. The rule table (`| Rule ID | Severity | Description |`, one row per rule)
 *      against `RULE_META` in `src/lib/lintEngine/ruleMeta.ts` — the one
 *      declaration, itself pinned to each emitter by `ruleMeta.test.ts`. The page
 *      said E05 was an Error (the code emits a warning) and carried the
 *      E06/E08/W05 descriptions under each other's ids.
 *   2. The trigger — the chord that runs lint — against the `validateMarkdown`
 *      default in `shortcutDefinitions.ts`, rendered the way `shortcuts.md`
 *      writes chords (`Alt-Mod-v` → `Alt + Mod + V`). The page said
 *      `Cmd + Shift + L`, which has never been the default. The F2 / Shift + F2
 *      rows (`lintNext` / `lintPrev`) are joined the same way, and EVERY chord
 *      written on the page must be one of those three defaults, so a stale one
 *      in prose is a finding too.
 *
 * Structural, not textual: the table is located by its header cells and read
 * row by row (cells split on unescaped `|`, the id inside `**…**`), and both
 * directions are asserted — a row for a rule that does not exist is as much a
 * finding as a rule with no row. `leadingTitle` takes the description up to the
 * first ` — `, `: ` or ` (`, so a row may elaborate after its title.
 *
 * The TS sources are EVALUATED, not regexed: `tsImport` (tsx) loads `ruleMeta.ts`
 * and `shortcutDefinitions.ts` as the modules they are, so a computed value or a
 * reordered field cannot fool the join. Both are import-free by construction,
 * which is what keeps that cheap. The renderer comes from
 * `scripts/lib/keybindingFormat.mjs` — the keybinding gate's own, extracted
 * because importing that gate runs it.
 *
 * Contract for the runner (`scripts/check-doc-joins.mjs`): `id`, `DEFAULT_PATHS`,
 * and `run({ root, paths, deps })` → `{ findings, info }`. `deps` lets a test
 * inject `{ ruleMeta, renderShortcut }` in place of the disk loads; `paths`
 * lets it point at fixture files under a temp root. A missing or malformed
 * source THROWS — fail closed, never an empty findings list.
 *
 * @coordinates-with src/lib/lintEngine/ruleMeta.ts — RULE_META
 * @coordinates-with src/stores/settingsStore/shortcutDefinitions.ts — the lint shortcut defaults
 * @coordinates-with scripts/lib/keybindingFormat.mjs — prosemirrorToDocs, the docs renderer
 * @coordinates-with scripts/lib/docJoins/lintTableChords.mjs — the chords a page writes, found and spelled
 * @coordinates-with website/guide/lint.md — the page under test
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitRow } from "./markdownTables.mjs";
import { chordsInDoc, docsChord } from "./lintTableChords.mjs";

export const id = "lint-table";

export const DEFAULT_PATHS = {
  lintDoc: "website/guide/lint.md",
  ruleMeta: "src/lib/lintEngine/ruleMeta.ts",
  shortcuts: "src/stores/settingsStore/shortcutDefinitions.ts",
  /** The module holding the keybinding gate's docs renderer (`prosemirrorToDocs`). */
  keybindingScript: "scripts/lib/keybindingFormat.mjs",
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Trigger-table rows joined to shortcut ids: the Action cell text → the definition that binds it. */
const TRIGGER_ROWS = [
  { shortcutId: "validateMarkdown", action: "Run lint on the active document" },
  { shortcutId: "lintNext", action: "Jump to the next diagnostic" },
  { shortcutId: "lintPrev", action: "Jump to the previous diagnostic" },
];

/** The description up to the first ` — `, `: ` or ` (` — the part that must equal the rule's title. */
export function leadingTitle(description) {
  const cuts = [" — ", ": ", " ("].map((s) => description.indexOf(s)).filter((i) => i >= 0);
  return (cuts.length ? description.slice(0, Math.min(...cuts)) : description).trim();
}

const severityLabel = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * Cells of one table row. Delegates to `markdownTables.splitRow` — the shared
 * GFM splitter — rather than carrying a second one: the lookbehind this
 * replaced read the `\` of an even backslash run as an escape, and stripped a
 * TRAILING `\|` as though it were the row's outer delimiter.
 */
const splitCells = splitRow;

const isRow = (line) => line.trim().startsWith("|");
/**
 * A GFM delimiter row: every cell is `-`/`:`, and it has the SAME number of
 * cells as its header. GFM requires that equality — without it a pipe line
 * followed by a shorter dash line was read as a table nothing renders as one.
 */
const isDelimiterRow = (line, headerCells) => {
  const cells = splitCells(line);
  return cells.length === headerCells && cells.every((c) => /^:?-+:?$/.test(c));
};

/** Body rows of the table whose header cells equal `header` (case-insensitive), or null when absent. */
function findTable(doc, header) {
  const lines = doc.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isRow(lines[i]) || !isDelimiterRow(lines[i + 1], splitCells(lines[i]).length)) continue;
    const cells = splitCells(lines[i]).map((c) => c.replace(/\*\*/g, "").toLowerCase());
    if (cells.length !== header.length || !header.every((h, k) => cells[k] === h.toLowerCase())) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && isRow(lines[j]); j++) rows.push({ line: j + 1, cells: splitCells(lines[j]) });
    return rows;
  }
  return null;
}

function joinRuleTable(doc, ruleMeta, { docPath, metaPath }, findings, info) {
  const rows = findTable(doc, ["Rule ID", "Severity", "Description"]);
  if (!rows) {
    findings.push(`${docPath}: no \`| Rule ID | Severity | Description |\` table found`);
    return;
  }
  const byId = new Map(ruleMeta.map((m) => [m.id, m]));
  const seen = new Set();
  for (const { line, cells } of rows) {
    if (cells.length !== 3) {
      findings.push(`${docPath}:${line}: expected 3 cells in the rule table, found ${cells.length}`);
      continue;
    }
    const [idCell, severityCell, description] = cells;
    const bold = /^\*\*([^*|]+)\*\*$/.exec(idCell);
    const rid = bold ? bold[1].trim() : idCell;
    if (!bold) findings.push(`${docPath}:${line}: Rule ID cell ${JSON.stringify(idCell)} is not bold — write it as **${rid}**`);
    if (seen.has(rid)) findings.push(`${docPath}:${line}: ${rid} is documented twice`);
    seen.add(rid);
    const meta = byId.get(rid);
    if (!meta) {
      findings.push(`${docPath}:${line}: ${rid} is documented but ${metaPath} has no such rule`);
      continue;
    }
    const want = severityLabel(meta.severity);
    if (severityCell !== want) {
      findings.push(`${docPath}:${line}: ${rid} severity is "${severityCell}" but the code emits it as ${want} (${metaPath})`);
    }
    const title = leadingTitle(description);
    if (title !== meta.title) {
      findings.push(`${docPath}:${line}: ${rid} title is ${JSON.stringify(title)} but ${metaPath} says ${JSON.stringify(meta.title)}`);
    }
  }
  for (const m of ruleMeta) {
    if (!seen.has(m.id)) findings.push(`${docPath}: ${m.id} (${severityLabel(m.severity)} — ${m.title}) has no row in the rule table`);
  }
  info.push(`${rows.length} documented rules joined against ${ruleMeta.length} in ${metaPath}`);
}

function joinTriggers(doc, shortcuts, renderShortcut, { docPath, defsPath }, findings, info) {
  const rows = findTable(doc, ["Trigger", "Action"]);
  if (!rows) {
    findings.push(`${docPath}: no \`| Trigger | Action |\` table found`);
    return;
  }
  // A trigger table row is `| Trigger | Action |`. A row of any other arity is
  // a malformed table, not a documented trigger — and `cells[1]` on one still
  // matched, so a three-cell row could satisfy the join. Duplicate Action rows
  // are refused too: `find` would take an arbitrary one of them.
  const seenActions = new Set();
  for (const { line, cells } of rows) {
    if (cells.length !== 2) {
      findings.push(`${docPath}:${line}: expected 2 cells in the trigger table, found ${cells.length}`);
      continue;
    }
    if (seenActions.has(cells[1])) findings.push(`${docPath}:${line}: the trigger table documents "${cells[1]}" twice`);
    seenActions.add(cells[1]);
  }
  const allowed = new Set();
  for (const { shortcutId, action } of TRIGGER_ROWS) {
    const def = shortcuts.find((d) => d.id === shortcutId);
    if (!def) {
      findings.push(`${defsPath}: no shortcut definition with id "${shortcutId}"`);
      continue;
    }
    for (const key of [def.defaultKey, def.defaultKeyMac, def.defaultKeyOther]) if (key) allowed.add(renderShortcut(key));
    const row = rows.find((r) => r.cells.length === 2 && r.cells[1] === action);
    if (!row) {
      findings.push(`${docPath}: the trigger table has no "${action}" row (${shortcutId})`);
      continue;
    }
    const want = renderShortcut(def.defaultKey);
    if (!want) {
      if (chordsInDoc(row.cells[0]).length > 0) {
        findings.push(`${docPath}:${row.line}: ${shortcutId} is unbound by default, but the "${action}" row documents a chord`);
      }
      continue;
    }
    if (!row.cells[0].includes(`\`${want}\``)) {
      findings.push(`${docPath}:${row.line}: "${action}" trigger is ${JSON.stringify(row.cells[0])} — the ${shortcutId} default is \`${want}\` (${defsPath})`);
    }
    info.push(`trigger ${shortcutId} → ${want}`);
  }
  const allowedList = [...allowed].map((c) => `\`${c}\``).join(", ");
  for (const { line, text, tokens } of chordsInDoc(doc)) {
    if (!allowed.has(docsChord(tokens))) {
      findings.push(`${docPath}:${line}: stale chord ${JSON.stringify(text)} — the lint shortcuts are ${allowedList} (${defsPath})`);
    }
  }
}

/** Evaluate a TypeScript module as the module it is (tsx), rather than pattern-matching its text. */
async function evaluateTs(absPath) {
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(pathToFileURL(absPath).href, import.meta.url);
}

function checkedRuleMeta(meta, source) {
  if (!Array.isArray(meta) || meta.length === 0) throw new Error(`${source}: RULE_META is not a non-empty array`);
  const ids = new Set();
  for (const m of meta) {
    if (typeof m?.id !== "string" || !["error", "warning"].includes(m?.severity) || typeof m?.title !== "string") {
      throw new Error(`${source}: malformed RULE_META entry ${JSON.stringify(m)}`);
    }
    // A duplicate id makes both directions of the join lie: `byId` keeps the
    // LAST entry, so the row is checked against one of them, and the
    // completeness loop finds `seen` holds the id and calls BOTH documented.
    if (ids.has(m.id)) throw new Error(`${source}: RULE_META declares "${m.id}" twice — one rule, one row`);
    ids.add(m.id);
  }
  return meta;
}

/**
 * The three shortcut definitions this join consumes must each exist exactly
 * once and carry string keys. `Array.isArray` alone let a duplicate id through
 * — `find` then picked an arbitrary one — and a non-string `defaultKey` reached
 * the renderer as whatever it was.
 */
function checkedShortcuts(defs, source) {
  if (!Array.isArray(defs)) throw new Error(`${source}: DEFAULT_SHORTCUTS is not an array`);
  for (const { shortcutId } of TRIGGER_ROWS) {
    const matches = defs.filter((d) => d?.id === shortcutId);
    if (matches.length > 1) throw new Error(`${source}: DEFAULT_SHORTCUTS declares "${shortcutId}" ${matches.length} times — one id, one definition`);
    for (const d of matches) {
      for (const field of ["defaultKey", "defaultKeyMac", "defaultKeyOther"]) {
        if (d[field] !== undefined && d[field] !== null && typeof d[field] !== "string") {
          throw new Error(`${source}: "${shortcutId}".${field} is ${JSON.stringify(d[field])}, not a key string`);
        }
      }
    }
  }
  return defs;
}

async function loadRenderer(absPath) {
  const mod = await import(pathToFileURL(absPath).href);
  if (typeof mod.prosemirrorToDocs !== "function") throw new Error(`${absPath}: does not export prosemirrorToDocs()`);
  return mod.prosemirrorToDocs;
}

/**
 * Run the join. Throws on an unreadable or malformed source; otherwise returns
 * every disagreement as a finding (an empty list is green) plus what was joined.
 */
export async function run({ root = REPO_ROOT, paths = DEFAULT_PATHS, deps = {} } = {}) {
  const p = { ...DEFAULT_PATHS, ...paths };
  const findings = [];
  const info = [];
  const doc = readFileSync(join(root, p.lintDoc), "utf8");
  const ruleMeta = checkedRuleMeta(deps.ruleMeta ?? (await evaluateTs(join(root, p.ruleMeta))).RULE_META, p.ruleMeta);
  const shortcuts = checkedShortcuts((await evaluateTs(join(root, p.shortcuts))).DEFAULT_SHORTCUTS, p.shortcuts);
  const renderShortcut = deps.renderShortcut ?? (await loadRenderer(join(root, p.keybindingScript)));
  joinRuleTable(doc, ruleMeta, { docPath: p.lintDoc, metaPath: p.ruleMeta }, findings, info);
  joinTriggers(doc, shortcuts, renderShortcut, { docPath: p.lintDoc, defsPath: p.shortcuts }, findings, info);
  return { findings, info };
}
