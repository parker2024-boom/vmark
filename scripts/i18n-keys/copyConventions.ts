/**
 * English copy conventions: the casing register a key's pattern selects, and
 * the punctuation vocabulary, ratcheted against scripts/i18n-copy-baseline.json.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @coordinates-with .claude/rules/35-copy-conventions.md — the rule this enforces
 * @module scripts/i18n-keys/copyConventions
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./paths.js";

// ─── Copy conventions (R14) ──────────────────────────────────────────────────
//
// Two casing registers, keyed on the KEY PATTERN (never guessed from the
// value): chrome nouns (menus, titles, buttons) read Title Case; running copy
// (labels, descriptions, toasts, placeholders) reads Sentence case. Plus the
// punctuation vocabulary: `…` never `...`, `→` never `->`/`>` in navigation
// paths, and descriptions carry no trailing period (Q3).
//
// The baseline (scripts/i18n-copy-baseline.json) is an IDENTITY list that
// ratchets both ways — a new violation fails, and a fixed one fails until its
// entry is removed (run with --update-copy to record wins). English only:
// each locale has its own casing conventions.

// `*.group` / `*.group.<name>` are settings section headings — 19 of them
// were Title Case and three were not, because this register did not list them.
const TITLE_KEY = /^(menu|contextMenu|tabMenu|toolbar)\.|\.title$|[bB]utton|\.group(\.[A-Za-z]+)?$/;
// ARIA labels are SPOKEN copy — sentence register regardless of their home key.
const ARIA_KEY = /aria/i;
const SENTENCE_KEY = /\.(label|description|empty|placeholder)$|Description$|^toast\./;

/** Whether a key's value is a chrome noun, written in Title Case (rule 35). */
export function titleRegister(key: string): boolean {
  return TITLE_KEY.test(key) && !SENTENCE_KEY.test(key) && !ARIA_KEY.test(key);
}
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "nor", "but", "of", "to", "in", "on", "at",
  "for", "with", "as", "by", "from", "into", "onto", "per", "via", "vs",
  "is", "are", "not", "no", "when", "if", "this", "that",
]);

export function titleCaseViolations(value: string): boolean {
  // Words = alphabetic runs outside interpolations; the FIRST word must be
  // capped; later words may be stop words.
  const clean = value.replace(/\{\{[^}]+\}\}|%\{[^}]+\}/g, " ");
  const words = clean.split(/[^A-Za-z’']+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.some((w, i) => {
    if (/^[A-Z0-9]/.test(w)) return false;
    // A lowercase start with an internal capital is a brand's own spelling
    // (macOS, iCloud, iPhone), never an uncapitalised word.
    if (/^[a-z]+[A-Z]/.test(w)) return false;
    if (i > 0 && STOP_WORDS.has(w.toLowerCase())) return false;
    return true;
  });
}

const CJK_CHAR = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

/**
 * English copy spaces its em-dashes ("word — word", AGENTS.md). `lint:emdash`
 * reads Markdown only, so UI strings are checked here. A doubled `——` is CJK
 * punctuation and a dash beside CJK text follows CJK rules; a placeholder
 * brace counts as a word, since `{{name}}—copy` renders as one.
 */
export function emdashSpacingViolation(value: string): boolean {
  for (let i = value.indexOf("—"); i !== -1; i = value.indexOf("—", i + 1)) {
    const before = value[i - 1] ?? "";
    const after = value[i + 1] ?? "";
    if (before === "—" || after === "—" || CJK_CHAR.test(before) || CJK_CHAR.test(after)) continue;
    if (/[\w}]/.test(before) || /[\w{]/.test(after)) return true;
  }
  return false;
}

/** Exported (with an injectable baseline path) so the fail-closed missing-
 *  baseline behavior has a behavioral test — the scan itself reads the real
 *  locale tree either way. */
export function checkCopyConventions(
  update: boolean,
  baselinePath: string = join(ROOT, "scripts", "i18n-copy-baseline.json"),
): boolean {
  const enDir = join(ROOT, "src", "locales", "en");
  const found: string[] = [];

  for (const file of readdirSync(enDir).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(enDir, file), "utf8")) as Record<string, unknown>;
    for (const [key, raw] of Object.entries(data)) {
      if (typeof raw !== "string") continue;
      const value = raw;
      const id = (check: string) => `${file}:${key}:${check}`;
      if (value.includes("...")) found.push(id("ellipsis"));
      if (emdashSpacingViolation(value)) found.push(id("emdash"));
      if (/\s->\s/.test(value)) found.push(id("arrow"));
      if (/Settings\s*>\s*[A-Z]/.test(value)) found.push(id("nav-arrow"));
      if (/"\{\{/.test(value) || /\}\}"/.test(value)) found.push(id("straight-quotes"));
      if (SENTENCE_KEY.test(key) && key.endsWith(".description") && /[.。]$/.test(value.trim()) && !/[.][.][.]|…$/.test(value.trim())) {
        found.push(id("trailing-period"));
      }
      if (titleRegister(key) && titleCaseViolations(value)) {
        found.push(id("title-case"));
      }
    }
  }

  // en.yml punctuation only (casing there follows the same menu register but
  // the yml is scanned for the vocabulary set).
  const yml = readFileSync(join(ROOT, "src-tauri", "locales", "en.yml"), "utf8");
  yml.split("\n").forEach((line, i) => {
    const m = /^\s*([A-Za-z0-9._-]+):\s*(.*)$/.exec(line);
    if (!m) return;
    const [, key, val] = m;
    if (val.includes("...")) found.push(`en.yml:${key}:ellipsis`);
    if (emdashSpacingViolation(val)) found.push(`en.yml:${key}:emdash`);
    if (/Settings\s*>\s*[A-Z]/.test(val)) found.push(`en.yml:${key}:nav-arrow`);
    void i;
  });

  found.sort();
  const baseline: string[] = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, "utf8")) as { entries: string[] }).entries
    : [];
  const added = found.filter((f) => !baseline.includes(f));
  const fixed = baseline.filter((b) => !found.includes(b));

  // A missing baseline is an ERROR, not an invitation to write one: silently
  // rebaselining every current violation on a deleted/renamed file is fail-open
  // (mirrors checkUntranslatedValues). Only --update-copy writes.
  if (!update && !existsSync(baselinePath)) {
    console.error(
      `[FAIL]  copy-convention baseline missing (${baselinePath}) — restore it, or regenerate deliberately with --update-copy.`,
    );
    return false;
  }
  if (update) {
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          "//":
            "WI-UI4.2 copy-convention baseline (identity, ratchets both ways). A NEW casing/punctuation " +
            "violation fails; a fixed one fails until removed (pnpm lint:i18n --update-copy). English only.",
          entries: found,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`[OK]    copy conventions: baseline written with ${found.length} entr(ies).`);
    return true;
  }

  if (added.length) {
    console.error(`[FAIL]  ${added.length} NEW copy-convention violation(s):`);
    for (const a of added.slice(0, 20)) console.error(`        ${a}`);
    return false;
  }
  if (fixed.length) {
    console.error(`[FAIL]  ${fixed.length} baselined copy entr(ies) now pass — record the win with --update-copy:`);
    for (const f of fixed.slice(0, 20)) console.error(`        ${f}`);
    return false;
  }
  console.log(`[OK]    copy conventions held (${baseline.length} baselined).`);
  return true;
}
