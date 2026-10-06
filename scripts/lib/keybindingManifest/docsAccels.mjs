/**
 * Accelerators as the docs table (`website/guide/shortcuts.md`) writes them,
 * canonicalised so a definition's key can be looked up in it.
 *
 * Purpose: the keybinding gate requires every menu-backed shortcut to be
 * documented. This module reads the table (inline code spans and plain table
 * cells), canonicalises modifier order and letter case, and reads the
 * compressed `` `A` through `B` `` range cells the docs use for runs of keys.
 *
 * @coordinates-with scripts/check-keybinding-manifest.mjs — the CLI that runs the legs
 * @module scripts/lib/keybindingManifest/docsAccels
 */
import { fail } from "./context.mjs";

const MOD_TOKENS = new Set(["Mod", "Alt", "Ctrl", "Shift", "Cmd", "Option"]);
const GRAVE = "`key"; // canonical token for the backtick key
/** Sentinel that survives fence-stripping, standing in for a backtick KEY. */
const DOC_BT_SENTINEL = "\u0001";
const NAMED_KEYS = new Set([
  "Up", "Down", "Left", "Right", "Enter", "Escape", "Esc", "Tab",
  "Backspace", "Space", "Delete", "Home", "End", "PageUp", "PageDown",
]);

/** Canonicalise one accelerator token (case-fold single letters, unify backtick). */
function canonToken(t) {
  if (t === "`" || t === DOC_BT_SENTINEL) return GRAVE;
  if (t.length === 1 && /[a-z]/i.test(t)) return t.toUpperCase();
  return t;
}

/**
 * Order-insensitive canonical form of an accelerator token list: modifiers are
 * sorted (so `Mod-Alt-]` and the docs' `Alt + Mod + ]` compare equal — the docs
 * legitimately normalise modifier order), then the non-modifier key(s) appended.
 */
export function canonAccel(tokens) {
  const canon = tokens.map(canonToken);
  const mods = canon.filter((t) => MOD_TOKENS.has(t)).sort();
  const keys = canon.filter((t) => !MOD_TOKENS.has(t));
  return [...mods, ...keys].join("+");
}

/** Is `t` a plausible accelerator token (modifier, single key, F-key, or named key)? */
function isAccelToken(t) {
  if (t === DOC_BT_SENTINEL) return true;
  if (MOD_TOKENS.has(t)) return true;
  if (/^F\d{1,2}$/.test(t)) return true;
  if (NAMED_KEYS.has(t)) return true;
  return t.length === 1; // single char: letter, digit, or punctuation key
}

/** Add one docs cell/code-span's accelerator (if it parses as one) to `set`. */
function addDocsAccel(set, cell) {
  const trimmed = cell.replace(/_[^_]*_/g, "").trim(); // drop italic annotations
  if (!trimmed) return;
  const toks = trimmed.includes("+")
    ? trimmed.split("+").map((t) => t.trim()).filter(Boolean)
    : [trimmed];
  if (toks.length === 0 || !toks.every(isAccelToken)) return;
  set.add(canonAccel(toks));
}

/**
 * Build the set of canonical accelerators present in the docs table. Two passes:
 *   1. every inline code span (`` `Mod + 1` ``) — catches range cells that list
 *      several accelerators in one table cell, and
 *   2. every `|`-delimited table cell after fence-stripping — catches un-fenced
 *      accelerators and single-key cells (`` `F4` `` in the F-key reference).
 * The backtick KEY (rendered as the code span `` `` ` `` ``) is swapped for a
 * sentinel first so fence-stripping can't erase it.
 */
export function buildDocsAccelSet(raw, rel) {
  const withSentinel = raw.replace(/``\s*`\s*``/g, ` ${DOC_BT_SENTINEL} `);
  const set = new Set();
  for (const m of withSentinel.matchAll(/`([^`\n]+)`/g)) addDocsAccel(set, m[1]);
  const stripped = withSentinel.replace(/`+/g, " ");
  for (const line of stripped.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    for (const cell of line.split("|")) addDocsAccel(set, cell);
  }
  if (set.size === 0) fail(`${rel}: parsed zero accelerators from the docs table`);
  return set;
}

/**
 * An accelerator's modifiers and its single key, or null when it is not a
 * one-key chord — the shape a compressed range can talk about.
 */
function accelParts(tokens) {
  const canon = tokens.map(canonToken);
  const keys = canon.filter((t) => !MOD_TOKENS.has(t));
  if (keys.length !== 1 || keys[0].length !== 1) return null;
  return { mods: canon.filter((t) => MOD_TOKENS.has(t)).sort().join("+"), key: keys[0] };
}

/**
 * Every compressed range the docs table writes as `` `A` through `B` `` in one
 * cell, as `{ mods, from, to, text }`. Only chords that differ in exactly their
 * one key can form a range, so a pair with different modifiers is not one.
 */
export function docsRanges(raw) {
  const out = [];
  for (const m of raw.matchAll(/`([^`\n]+)`\s+through\s+`([^`\n]+)`/g)) {
    const from = accelParts(m[1].split("+").map((t) => t.trim()).filter(Boolean));
    const to = accelParts(m[2].split("+").map((t) => t.trim()).filter(Boolean));
    if (from && to && from.mods === to.mods && from.key <= to.key) {
      out.push({ mods: from.mods, from: from.key, to: to.key, text: `${m[1]} through ${m[2]}` });
    }
  }
  return out;
}

/** The documented range covering `tokens`, or null. */
export function coveringRange(ranges, tokens) {
  const p = accelParts(tokens);
  if (!p) return null;
  return ranges.find((r) => r.mods === p.mods && r.from <= p.key && p.key <= r.to) ?? null;
}
