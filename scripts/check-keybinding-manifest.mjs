#!/usr/bin/env node
/**
 * Keybinding drift gate.
 *
 * A keyboard shortcut with a native menu accelerator lives in THREE sources that
 * must agree (`.claude/rules/41-keyboard-shortcuts.md`):
 *   1. `src/stores/settingsStore/shortcutDefinitions.ts` — frontend defaults,
 *      the source of truth; the synced subset is DERIVED from it here (every
 *      entry with a `menuId`, minus the dynamically-bound ones)
 *   2. `src-tauri/src/menu/localized/*.rs` — the REAL Rust menu builder
 *      (`accel("<menu-id>", "<default-accel>")` call sites), pinned as a contract
 *      mirror in `src-tauri/src/menu/localized.test.rs`
 *      (`DEFAULT_ACCELERATORS` / `PLATFORM_ACCELERATORS`)
 *   3. `website/guide/shortcuts.md` — the human-readable docs table
 *
 * There used to be a fourth: a hand-written `keybindingManifest.ts` restating
 * each entry's keys, which this gate then compared against the definitions it
 * was copied from. That comparison could only fail if someone forgot to copy —
 * it caught clerical omissions, never drift. Everything that catches real drift
 * compares ACROSS LANGUAGES, and all of it survives derivation.
 *
 * For every synced entry this gate asserts:
 *   - the Rust CONTRACT MIRROR accelerator for the entry's `menuId` equals
 *     `prosemirrorToTauri(defaultKey)` (and `prosemirrorToTauri(defaultKeyOther)`
 *     for platform-conditional entries),
 *   - the REAL menu builder's `accel(...)` call site for that `menuId` equals the
 *     same value (closing the "checked against a test mirror, not the real menu"
 *     gap — a drift between the mirror and the real builder is now visible here,
 *     not only in the macOS-only Rust test), and
 *   - the docs table lists EVERY effective platform accelerator the entry binds
 *     — `defaultKeyMac ?? defaultKey` and `defaultKeyOther ?? defaultKey`,
 *     order-insensitively; a menu-backed shortcut must be documented.
 * It also asserts the reverse direction on BOTH Rust sources: every non-empty
 * accelerator the real menu builder binds, and every non-empty tuple the
 * contract mirror holds, must map to a synced entry (or an explicit
 * allow-listed id with a stated reason). Without the mirror half, a renamed or
 * deleted shortcut left its old tuple behind to validate against itself.
 *
 * Nothing is EXECUTED — no TS runtime, no cargo — so the gate runs under plain
 * `node`; but the TypeScript sources are PARSED (`typescript`, the way this
 * repo's other AST gates read TS) and the Rust sources go through
 * `lib/rustSource.mjs`'s comment/literal lexer. Text scanning was the defect:
 * a definitions entry could hide its `id` behind a comment or a nested object,
 * a `...SPREAD` element contributed shortcuts nothing checked, and a
 * commented-out mirror tuple stood in for the contract.
 * It fails closed: a missing file, an unreadable table, a parse
 * error, or an array element shape it does not understand exits non-zero.
 * Run via `pnpm lint:keybinding-manifest` (wired into check:all).
 *
 * This file is the CLI: it holds the exemption lists, loads the four sources
 * and runs the legs in order. The legs live in `lib/keybindingManifest/`.
 *
 * @coordinates-with scripts/lib/keybindingManifest/context.mjs — paths and the fail-closed exits
 * @coordinates-with scripts/lib/keybindingManifest/sourceArrays.mjs — the definitions and mirror arrays
 * @coordinates-with scripts/lib/keybindingManifest/realMenu.mjs — the real menu builder's accel(...) sites
 * @coordinates-with scripts/lib/keybindingManifest/docsAccels.mjs — the docs table
 * @coordinates-with scripts/lib/keybindingManifest/entryChecks.mjs — per-entry and reverse legs
 * @coordinates-with scripts/lib/keybindingManifest/labelParity.mjs — the label leg
 * @coordinates-with scripts/check-keybinding-manifest.test.mjs — the self-test
 */

import { rustCode } from "./lib/rustSource.mjs";
import { DEFS_PATH, DOCS_PATH, LOCALIZED_DIR, RUST_PATH, fail, readOrDie, unquote } from "./lib/keybindingManifest/context.mjs";
import { arrayBody, parseObjectLiterals, readTuples } from "./lib/keybindingManifest/sourceArrays.mjs";
import { parseRealMenu } from "./lib/keybindingManifest/realMenu.mjs";
import { buildDocsAccelSet, docsRanges } from "./lib/keybindingManifest/docsAccels.mjs";
import { checkEntries, checkOrphanAccels } from "./lib/keybindingManifest/entryChecks.mjs";
import { checkLabelParity } from "./lib/keybindingManifest/labelParity.mjs";

/**
 * Menu ids whose accelerator is registered dynamically, not via a static menu
 * accel. Each names the SOURCE that binds it, and that binding is verified to
 * still exist below: an exemption is a claim about live code, and an
 * un-checked one silently removes a real shortcut from every cross-language
 * comparison the moment the dynamic path is deleted.
 */
const DYNAMIC_MENU_IDS = new Map([
  ["search-genies", { source: "src/hooks/useGenieShortcuts.ts", reason: "accelerator registered at runtime by useGenieShortcuts" }],
]);

/**
 * Menu ids that the real menu builder binds a non-empty accelerator to but which
 * are intentionally NOT in the manifest: OS-standard editor commands with no
 * `menuId` entry in `shortcutDefinitions.ts` (not user-customizable). The reverse
 * "real accel with no manifest entry" report allow-lists these.
 */
const NON_MANIFEST_MENU_ACCELS = new Map([
  ["undo", "OS-standard Undo — predefined, not in the customizable shortcut registry"],
  ["redo", "OS-standard Redo — predefined, not in the customizable shortcut registry"],
  ["quit", "OS-standard Quit — predefined, not in the customizable shortcut registry"],
]);

/**
 * Manifest ids whose accelerator is documented only inside a COMPRESSED RANGE in
 * `website/guide/shortcuts.md` ("Heading 1-6 | `Mod + 1` through `Mod + 6`"), so
 * it has no individual accelerator cell. `heading-1` and `heading-6` DO render as
 * individual code spans and are checked normally; only the interior levels are
 * exempt from the docs presence check.
 *
 * The exemption is a CLAIM ABOUT THE DOCS, and it is verified against them —
 * the rule `DYNAMIC_MENU_IDS` already carries. Each entry was a permanent pass
 * granted on a range nothing read: delete the range row, narrow it to
 * `Mod + 1` through `Mod + 3`, or rename the id, and four menu-backed
 * shortcuts left every docs comparison with the gate still green.
 * Now the range row must exist, its endpoints must share the entry's
 * modifiers, and the entry's own key must fall between them.
 */
const DOCS_RANGE_DOCUMENTED = new Map([
  ["heading-2", 'documented as the range "Mod + 1 through Mod + 6"'],
  ["heading-3", 'documented as the range "Mod + 1 through Mod + 6"'],
  ["heading-4", 'documented as the range "Mod + 1 through Mod + 6"'],
  ["heading-5", 'documented as the range "Mod + 1 through Mod + 6"'],
]);

const errors = [];

// --- Load frontend definitions ---
const defsSrc = readOrDie(DEFS_PATH);
const defs = parseObjectLiterals(
  arrayBody(defsSrc, "DEFAULT_SHORTCUTS", DEFS_PATH),
  DEFS_PATH,
  "DEFAULT_SHORTCUTS",
);

// --- Derive the synced subset ---
// Every definition carrying a `menuId`, minus the dynamically-bound ones. This
// used to be a hand-copied file (`keybindingManifest.ts`) that the gate then
// compared against these same definitions — an equality between two copies of
// one value, which cannot fail unless someone forgets to copy. What actually
// catches drift is the comparison against the OTHER languages: the Rust mirror,
// the real menu builder, and the docs table. Those run against the derived set
// unchanged.
const manifest = defs
  .filter((d) => d.menuId && !DYNAMIC_MENU_IDS.has(d.menuId))
  .map((d) => ({
    id: d.id,
    label: d.label,
    defaultKey: d.defaultKey,
    defaultKeyMac: d.defaultKeyMac,
    defaultKeyOther: d.defaultKeyOther,
    menuId: d.menuId,
  }));
// Zero DEFINITIONS first, then zero DERIVED entries. The other order made the
// definitions check unreachable — no definitions implies no manifest, so the
// manifest `fail()` always fired first and reported a derivation problem for
// what is really a parse that read nothing.
if (defs.length === 0) fail(`${DEFS_PATH}: parsed zero shortcut definitions`);
if (manifest.length === 0) fail(`${DEFS_PATH}: derived zero menu-backed shortcuts`);
const defById = new Map(defs.map((d) => [d.id, d]));

// --- Load Rust contract tables ---
// Comments are blanked (nested-aware, offsets preserved) before the tuple
// regexes run: a commented-out tuple counted as the contract, so a mirror
// whose live entry had been deleted could still validate against the comment
// left behind. `keepStrings` because the accelerators ARE the
// string literals this reads.
const rustSrc = rustCode(readOrDie(RUST_PATH), { keepStrings: true });
const rustDefaultBody = arrayBody(rustSrc, "const DEFAULT_ACCELERATORS", RUST_PATH);
const rustPlatformBody = arrayBody(rustSrc, "const PLATFORM_ACCELERATORS", RUST_PATH);

// Duplicate ids in either contract table (or an id in BOTH) silently overwrote
// earlier entries via Map.set — a wrong-then-right duplicate would let the gate
// validate against the surviving tuple and pass. Fail closed on any duplicate.
const rustDefault = new Map();
for (const m of readTuples(rustDefaultBody, /\("([a-z0-9-]+)",\s*"((?:[^"\\]|\\.)*)"\)/g, "DEFAULT_ACCELERATORS")) {
  if (rustDefault.has(m[1])) fail(`${RUST_PATH}: duplicate id "${m[1]}" in DEFAULT_ACCELERATORS`);
  rustDefault.set(m[1], unquote(m[2]));
}
const rustPlatform = new Map();
for (const m of readTuples(rustPlatformBody, /\("([a-z0-9-]+)",\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g, "PLATFORM_ACCELERATORS")) {
  if (rustPlatform.has(m[1])) fail(`${RUST_PATH}: duplicate id "${m[1]}" in PLATFORM_ACCELERATORS`);
  if (rustDefault.has(m[1])) {
    fail(`${RUST_PATH}: id "${m[1]}" appears in BOTH DEFAULT_ACCELERATORS and PLATFORM_ACCELERATORS`);
  }
  rustPlatform.set(m[1], { mac: unquote(m[2]), other: unquote(m[3]) });
}
if (rustDefault.size === 0) fail(`${RUST_PATH}: parsed zero DEFAULT_ACCELERATORS entries`);
if (rustPlatform.size === 0) fail(`${RUST_PATH}: parsed zero PLATFORM_ACCELERATORS entries`);

// --- Load the REAL Rust menu builder (accel(...) call sites) ---
const { realDefault, realPlatform } = parseRealMenu();

// --- Load the docs table accelerators ---
const docsSrc = readOrDie(DOCS_PATH);
const docsAccels = buildDocsAccelSet(docsSrc, DOCS_PATH);
const docsRangeCells = docsRanges(docsSrc);

// --- Dynamic-exemption liveness: the binding each exemption cites must exist ---
for (const [id, { source, reason }] of DYNAMIC_MENU_IDS) {
  const src = readOrDie(source);
  if (!src.includes(`"${id}"`)) {
    errors.push(
      `stale DYNAMIC_MENU_IDS entry "${id}": ${source} no longer names it (${reason}). ` +
        "The exemption removes the id from every check here, so a dead dynamic binding " +
        "would take the shortcut out of the gate with nothing to fail on — delete the " +
        "exemption so the id is checked statically, or point it at the new binding.",
    );
  }
}

const manifestMenuIds = new Set(manifest.map((e) => e.menuId).filter(Boolean));

// Range-exemption liveness, the other direction: an exempt id that is no longer
// a menu-backed shortcut is a rename the map outlived, and it would go on
// exempting whatever takes that id next (the rule LABEL_EXEMPT/UNPAIRED_OK
// already carry).
for (const id of DOCS_RANGE_DOCUMENTED.keys()) {
  if (!manifestMenuIds.has(id)) {
    errors.push(`stale DOCS_RANGE_DOCUMENTED entry "${id}": no such menu id in the manifest — remove it.`);
  }
}

// Two definitions on ONE native command: the menu binds one accelerator, so
// the second definition's key can never reach it through the menu — and when
// both keys coincide every per-entry check below passes twice. Reject.
{
  const byMenuId = new Map();
  for (const e of manifest) {
    if (byMenuId.has(e.menuId)) errors.push(`manifest: menuId "${e.menuId}" is claimed by both "${byMenuId.get(e.menuId)}" and "${e.id}"`);
    else byMenuId.set(e.menuId, e.id);
  }
}

checkEntries({
  manifest, defById, rustDefault, rustPlatform, realDefault, realPlatform,
  docsAccels, docsRangeCells, docsRangeDocumented: DOCS_RANGE_DOCUMENTED, errors,
});
checkOrphanAccels({
  manifestMenuIds, dynamicMenuIds: DYNAMIC_MENU_IDS, nonManifestMenuAccels: NON_MANIFEST_MENU_ACCELS,
  realDefault, realPlatform, rustDefault, rustPlatform, errors,
});
checkLabelParity(manifest, errors);

if (errors.length > 0) {
  console.error(`\n❌ Keybinding drift gate found ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  console.error(
    `\n  ${DEFS_PATH}, the real Rust menu builder (${LOCALIZED_DIR}), and the ` +
      `docs table (${DOCS_PATH})\n  have diverged. ` +
      "Reconcile all three per .claude/rules/41-keyboard-shortcuts.md.",
  );
  process.exit(1);
}

console.log(
  `✅ Keybinding drift gate passed (${manifest.length} menu-backed shortcuts aligned ` +
    `across ${DEFS_PATH}, the real Rust menu builder, and the docs table).`,
);
