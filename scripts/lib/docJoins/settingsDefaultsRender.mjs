/**
 * Purpose: render a defaults.ts value the way a settings page spells it, and
 *   read a dotted key out of the resolved defaults — the value side of the
 *   settings-defaults doc join.
 *
 * Rendering is explicit per ROW_MAP row: `true` → On, `0.4` → 40% on
 * settings.md but 40 % on terminal.md, enum values through a value→label map in
 * the page's own vocabulary. A value of the wrong type for its renderer THROWS,
 * so the join reports it instead of printing a plausible string.
 *
 * @coordinates-with scripts/lib/docJoins/settingsDefaults.mjs — the join that renders through this
 * @coordinates-with scripts/lib/docJoins/settingsDefaultsRowMap.mjs — the `render` specs this interprets
 * @module scripts/lib/docJoins/settingsDefaultsRender
 */

function expectType(value, type, render) {
  const ok = type === "array" ? Array.isArray(value) : typeof value === type;
  if (!ok) throw new Error(`renderer "${render}" expects ${type === "array" ? "an array" : `a ${type}`}, got ${JSON.stringify(value)}`);
  return value;
}

/** terminal.md writes `13 px` and `40 %`; settings.md writes `13px` and `40%`. */
const unit = (page, symbol) => (page === "terminal" ? ` ${symbol}` : symbol);

export const RENDERERS = {
  onOff: (v) => (expectType(v, "boolean", "onOff") ? "On" : "Off"),
  number: (v) => String(expectType(v, "number", "number")),
  seconds: (v) => `${expectType(v, "number", "seconds")} seconds`,
  px: (v, page) => `${expectType(v, "number", "px")}${unit(page, "px")}`,
  percent: (v, page) => `${Math.round(expectType(v, "number", "percent") * 100)}${unit(page, "%")}`,
  thousands: (v) => expectType(v, "number", "thousands").toLocaleString("en-US"),
  text: (v) => expectType(v, "string", "text") || "(empty)",
  list: (v) => expectType(v, "array", "list").join(", "),
};

/** Render `value` per a ROW_MAP `render` spec (a renderer name, `{ enum }` or `{ suffix, zero? }`); throws on anything it cannot express. */
export function renderDefault(render, value, page) {
  if (typeof render === "string") {
    const fn = RENDERERS[render];
    if (!fn) throw new Error(`unknown renderer "${render}"`);
    return fn(value, page);
  }
  if (render && typeof render === "object") {
    if ("enum" in render) {
      const label = Object.hasOwn(render.enum, String(value)) ? render.enum[String(value)] : undefined;
      if (label === undefined) throw new Error(`no label for value ${JSON.stringify(String(value))} in the enum map`);
      return label;
    }
    if ("suffix" in render) {
      if (value === 0 && render.zero !== undefined) return render.zero;
      return `${expectType(value, "number", "suffix")}${render.suffix}`;
    }
  }
  throw new Error(`unknown renderer ${JSON.stringify(render)}`);
}

/** `defaults.terminal.fontSize` for "terminal.fontSize"; undefined for any missing segment (own properties only). */
export function lookup(defaults, dotted) {
  let cur = defaults;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}
