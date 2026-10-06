/**
 * C11 and C12 of the ui-consistency gate: bar-height and z-index literals, and
 * positioned elements floating over content on a high layer. Pure functions
 * over source text.
 *
 * @coordinates-with scripts/lib/uiConsistencyCss.mjs — re-exports these checks to the CLI
 * @coordinates-with scripts/lib/uiConsistencyCssRules.mjs — rule iteration, markers, token resolution
 * @module scripts/lib/uiConsistencyLayers
 */
import { resolveNumeric, rulesWithMarkers, splitSelectorList, uiOkMarkers } from "./uiConsistencyCssRules.mjs";

/** Overlay families whose job IS to sit above content on a high layer. */
const OVERLAY_FAMILY =
  /popup|popover|menu|dropdown|tooltip|toast|overlay|backdrop|dialog|modal|picker|palette|finder|context|suggest|autocomplete|hover-card/i;

/**
 * C12 — nothing floats over content without a stated reason.
 *
 * The split-pane view-mode toggle was `position: absolute` at --z-toolbar,
 * pinned top-right over the panes, where it lay across the HTML trust bar,
 * the read-only banner and source text. C4 reads only `fixed` overlays at
 * --z-context-menu and above, so no check looked at it. A positioned element
 * on a layer at or above --z-bar is either an overlay family (what those
 * layers are for), the layer's owner in rule 32's z-table, or something that
 * covers content on purpose — the last two say so with ui-ok(float): <reason>.
 *
 * Judged PER SELECTOR, with `position` and `z-index` resolved through the
 * cascade of every rule in the file that names that selector: an overlay
 * neighbour in a selector list exempts nothing, splitting the two
 * declarations into separate rules does not hide the pair, and source order,
 * `!important` and enclosing at-rules decide which declaration applies.
 * `calc(var(--z-x) ± n)` resolves.
 *
 * Known limitations — static text cannot settle these; rule 32's WebKit
 * geometry tests are the check that can:
 *   - Sibling at-rules are treated as exclusive. `@media (min-width)` giving
 *     `position` and a separate `@media (min-height)` giving `z-index` both
 *     apply on a large window, but telling that apart from a wide/narrow pair
 *     means evaluating the queries.
 *   - One file at a time. Declarations for one selector split across
 *     stylesheets depend on load order, which the CSS does not state; rule 32
 *     keeps each component's styles in one file.
 */
export function checkFloatingOverContent(css, file, tokens, { problems }) {
  const barLayer = resolveNumeric("var(--z-bar)", tokens) ?? 100;
  const contextAt = atRuleContexts(css);
  /** selector -> its position/z-index declarations, in source order. */
  const bySelector = new Map();
  const floatOk = new Set();
  for (const rule of rulesWithMarkers(css)) {
    const path = contextAt(rule.index);
    if (path.some((p) => /^@(-\w+-)?keyframes\b/.test(p))) continue; // animation steps, not boxes
    const decls = [...rule.body.matchAll(/(?:^|[;{\s])(position|z-index)\s*:\s*([^;}]+)/g)].map((m) => {
      const important = /!\s*important\s*$/i.test(m[2]);
      const value = m[2].replace(/!\s*important\s*$/i, "").trim();
      return { prop: m[1], important, value: m[1] === "z-index" ? resolveZ(value, tokens) : value };
    });
    if (decls.length === 0) continue;
    const { markers, problems: mp } = uiOkMarkers(rule.rawBody);
    problems.push(...mp.map((p) => `${file}:${rule.selector}: ${p}`));
    const key = path.join(" > ");
    for (const selector of splitSelectorList(rule.selector)) {
      if (!bySelector.has(selector)) bySelector.set(selector, { line: rule.line, events: [] });
      bySelector.get(selector).events.push(...decls.map((d) => ({ ...d, key })));
      if (markers.has("float")) floatOk.add(selector);
    }
  }
  const applies = (eventKey, target) => eventKey === "" || target === eventKey || target.startsWith(`${eventKey} > `);
  const findings = [];
  for (const [selector, { line, events }] of bySelector) {
    if (OVERLAY_FAMILY.test(selector) || floatOk.has(selector)) continue;
    // The cascade, per context: in source order, apply every declaration whose
    // context is this one or an ancestor of it; an !important declaration
    // beats a normal one whatever the order. A later unconditional reset
    // therefore overrides an earlier @media rule, and a nested @supports
    // z-index composes with its @media's position. Only this selector's own
    // contexts need evaluating: the contexts enclosing any point form one
    // prefix chain, so every other point equals its deepest such context.
    let hit = null;
    for (const target of new Set(["", ...events.map((e) => e.key)])) {
      const st = {};
      for (const e of events) {
        if (!applies(e.key, target)) continue;
        const current = st[e.prop];
        if (current && current.important && !e.important) continue;
        st[e.prop] = e;
      }
      const position = st.position?.value;
      const layer = st["z-index"]?.value;
      if ((position === "absolute" || position === "fixed") && layer != null && layer >= barLayer) {
        hit = layer;
        break;
      }
    }
    if (hit === null) continue;
    findings.push({
      check: "C12",
      id: `${file}:${selector}`,
      message: `${file}:${line} ${selector}: positioned at z-index ${hit} (>= --z-bar) — it can cover content. Put it in flow (a header row, a docked slot), or mark ui-ok(float): <why it may cover content> (rule 32).`,
    });
  }
  return findings;
}

/**
 * index -> enclosing at-rule preludes, outermost first ([] at top level), by
 * brace matching on comment-blanked text with quoted strings skipped (a "}"
 * inside `content: "}"` is not a brace). cssRules reads flat text, so a rule
 * inside `@media` comes back with the same selector as the base rule; C12
 * must not merge the two.
 */
function atRuleContexts(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const ranges = [];
  const stack = [];
  let segmentStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      for (i += 1; i < text.length && text[i] !== ch; i += 1) if (text[i] === "\\") i += 1;
      continue;
    }
    if (ch === "{") {
      const prelude = text.slice(segmentStart, i).trim();
      stack.push({ prelude: prelude.startsWith("@") ? prelude.replace(/\s+/g, " ") : null, start: i });
      segmentStart = i + 1;
    } else if (ch === "}") {
      const open = stack.pop();
      if (open && open.prelude) ranges.push({ start: open.start, end: i, prelude: open.prelude });
      segmentStart = i + 1;
    } else if (ch === ";") {
      segmentStart = i + 1;
    }
  }
  return (index) =>
    ranges
      .filter((r) => r.start < index && index < r.end)
      .sort((a, b) => a.start - b.start)
      .map((r) => r.prelude);
}

/** A z-index value to a number: a literal, a token, or calc(token ± n). */
function resolveZ(value, tokens) {
  const direct = resolveNumeric(value, tokens);
  if (direct !== null) return direct;
  const calc = /^calc\(\s*var\(\s*(--[\w-]+)\s*\)\s*([+-])\s*(\d+)\s*\)$/.exec(value.trim());
  if (!calc) return null;
  const base = resolveNumeric(`var(${calc[1]})`, tokens);
  if (base === null) return null;
  return calc[2] === "+" ? base + Number(calc[3]) : base - Number(calc[3]);
}

/** C11 — bar-height literals and z-index literals outside index.css. */
export function checkHeightsAndZ(css, file, { problems }) {
  const findings = [];
  const seen = new Set();
  for (const rule of rulesWithMarkers(css)) {
    const { markers, problems: mp } = uiOkMarkers(rule.rawBody);
    problems.push(...mp.map((p) => `${file}:${rule.selector}: ${p}`));
    const declaresLocalHeightVar = /--[A-Za-z0-9-]*height\s*:/.test(rule.body);
    for (const m of rule.body.matchAll(/(?:^|[;{])\s*(height|min-height)\s*:\s*(40|38|28|22)px\s*[;}]?/g)) {
      if (declaresLocalHeightVar || markers.has("height")) continue;
      const id = `${file}:${rule.selector}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push({
        check: "C11",
        id,
        message: `${file}:${rule.line} ${rule.selector}: ${m[1]}: ${m[2]}px — this is a bar height; consume var(--bar-height)/the owning token (WI-UI3.5) or declare a local --*-height var (rule 31).`,
      });
    }
    for (const m of rule.body.matchAll(/(?:^|[;{])\s*z-index\s*:\s*(-?\d+)\s*[;}]?/g)) {
      const z = Number(m[1]);
      if (z <= 2) continue;
      findings.push({
        check: "C11z",
        id: `${file}:${rule.selector}`,
        message: `${file}:${rule.line} ${rule.selector}: z-index: ${z} — use the --z-* stack (rule 31); literals fork the stacking order.`,
      });
    }
  }
  return findings;
}
