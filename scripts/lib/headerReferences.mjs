/**
 * Header-reference resolution and collection — the pure half of
 * `scripts/check-header-references.mjs`.
 *
 * Purpose: take the references a file header carries (read by
 * `headerComments.mjs`: `@coordinates-with`, `@module`, `Plan:`), decide
 * per reference whether it resolves (target resolution is delegated to
 * `headerReferenceTargets.mjs`), and compare the unresolved set with the
 * identity baseline two-way. Everything here is a function of a root directory
 * and file contents — no process globals, no exit codes — so the self-test can
 * drive each grammar against fixture trees in a temp dir.
 *
 * Key decisions:
 *   - `@module` is tree-relative for the app and server trees and REPO-relative
 *     for the tooling trees (`scripts/`, `e2e/`, `.claude/hooks/`) — measured,
 *     not chosen: every `scripts/*.mjs` header writes `scripts/<name>`. An
 *     `index.*` file may name its directory (that IS its import specifier).
 *     Rust accepts `/` or `::`, and the `#[path = "…"] mod x;` mounted path.
 *   - `dev-docs/` targets are maintainer-local: checked only where the tree
 *     exists, probed by its `dev-docs/README.md` index — the marker a real
 *     dev-docs carries and no test fixture creates (clean-dev.test.mjs
 *     fabricates fixtures under the REAL `dev-docs/` in this tier, so a bare
 *     directory probe is the race check-ui-phase.sh records). Absent, they
 *     are neither findings nor stale entries, so CI stays green.
 *   - A retired plan (its file deleted) is written `Origin: <title> plan
 *     (retired) <§ as before>`, never `Plan:` with a dead path: `Origin:` is
 *     prose to this gate, so nothing has to resolve. It carries no date (rule
 *     22, enforced by `lint:provenance-ids`); a plan with a tracked copy is
 *     cited by that copy's path instead.
 *
 * @coordinates-with scripts/lib/headerComments.mjs — comment scanning and the tag grammar
 * @coordinates-with scripts/lib/headerReferenceTargets.mjs — resolves one target against the tree
 * @coordinates-with scripts/lib/headerReferenceTrees.mjs — the scanned trees and resolution indexes
 * @coordinates-with scripts/lib/rustSource.mjs — reads `#[path]` mounts over Rust code, not literals
 * @coordinates-with scripts/check-header-references.mjs — the CLI over these functions
 * @coordinates-with scripts/check-header-references.test.mjs — drives every grammar here
 * @module scripts/lib/headerReferences
 */
import path from "node:path";

import { rustCode } from "./rustSource.mjs";
import { KINDS, extractReferences, isGenerated } from "./headerComments.mjs";
import { resolvePathTarget, resolveRustModuleTarget } from "./headerReferenceTargets.mjs";
import { TREES, buildTailIndex, dependencyNames, fsAt, isRustDirFile, stripExtension, treeFor, walkSources } from "./headerReferenceTrees.mjs";

// The reading half lives in headerComments.mjs; re-exported so this module
// stays the one entry point the CLI and its self-test import from.
export { KINDS, commentLines, extractReferences, firstTarget } from "./headerComments.mjs";

const posix = path.posix;

export function identityKey(ref) {
  return `${ref.file}|${ref.kind}|${ref.target}`;
}

/**
 * `dev-docs/` is gitignored — a reference into it can only be checked where it
 * exists.
 *
 * Matched by SEGMENT. The prefix/substring form required a following slash, so
 * the directory itself — a bare `dev-docs`, `../dev-docs`, or `website/dev-docs`
 * — was not classified maintainer-local and became an unresolvable finding on
 * every machine that does not have the folder, i.e. CI. A
 * segment test also cannot be fooled by a `dev-docs-archive/` sibling, which
 * `startsWith` would have needed the slash to exclude anyway.
 */
export function isMaintainerLocal(target) {
  const t = target.replace(/^(\.\.?\/)+/, "");
  return t.split("/").includes("dev-docs");
}

export function isMaintainerLocalKey(key) {
  return isMaintainerLocal(key.split("|").slice(2).join("|"));
}

/** The file-derived module stem: `hot_exit/dedup.rs` → `hot_exit/dedup`, `x/mod.rs` → `x`. */
function moduleStem(file, tree) {
  const rel = posix.relative(tree.moduleBase, file);
  if (tree.lang === "rust" && isRustDirFile(rel)) {
    const dir = posix.dirname(rel);
    return dir === "." ? "" : dir;
  }
  return stripExtension(rel);
}

/** `#[path = "<this file>"] mod name;` in a sibling: the module path Rust actually gives the file. */
function pathMountedModulePaths(file, tree, fs) {
  const dir = posix.dirname(file);
  const base = posix.basename(file);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(String.raw`#\[path\s*=\s*"${escaped}"\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;`, "g");
  const out = [];
  if (!fs.isDir(dir)) return out;
  for (const sibling of fs.listDir(dir)) {
    if (!sibling.endsWith(".rs") || sibling === base) continue;
    const siblingFile = posix.join(dir, sibling);
    if (!fs.isFile(siblingFile)) continue;
    // Over CODE, not raw text: a `#[path = "…"] mod x;` inside a doc comment
    // or quoted in a string minted a module alias that let an invalid
    // `@module` header resolve. `keepStrings` because the path
    // IS a literal; the fully-blanked copy then tells a real attribute from
    // one that lived inside a literal — the two-pass rule dod-syntax.mjs's
    // rustModIncludes already applies to the same grammar.
    const siblingSource = fs.read(siblingFile);
    const code = rustCode(siblingSource, { keepStrings: true });
    const bare = rustCode(siblingSource);
    for (const m of code.matchAll(re)) {
      if (bare[m.index] !== "#") continue;
      const parent = moduleStem(siblingFile, tree);
      out.push(parent ? `${parent}::${m[1]}` : m[1]);
    }
  }
  return out;
}

/** Every `@module` value the file may legitimately carry. */
export function expectedModulePaths(file, fs, trees = TREES) {
  const tree = treeFor(file, trees);
  const stem = moduleStem(file, tree);
  const out = new Set([stem]);
  if (tree.lang === "rust") {
    out.add(stem.replaceAll("/", "::"));
    for (const alt of pathMountedModulePaths(file, tree, fs)) {
      out.add(alt);
      out.add(alt.replaceAll("::", "/"));
    }
  } else if (posix.basename(stem) === "index") {
    // `import x from "@/lib/cjkFormatter"` names the directory: that is the module.
    out.add(posix.dirname(stem));
  }
  out.delete("");
  out.delete(".");
  return out;
}

/** The shared resolution context for one root; `trees` threads through indexing, dependencies and tree lookup. */
export function resolutionContext(root, trees = TREES) {
  const fs = fsAt(root);
  return { root, fs, trees, devDocsPresent: fs.isFile("dev-docs/README.md"), index: buildTailIndex(fs, trees), deps: dependencyNames(fs, trees) };
}

/**
 * Decide one reference. `ctx` is a `resolutionContext(root)` (or `{ root }`, built on demand).
 * Returns `{ status: "resolved", via }`, `{ status: "unresolved", reason }` or `{ status: "skipped", reason }`.
 */
export function resolveReference(ref, ctx) {
  if (!ctx.fs) ctx = { ...resolutionContext(ctx.root, ctx.trees), ...(ctx.devDocsPresent === undefined ? {} : { devDocsPresent: ctx.devDocsPresent }) };
  const trees = ctx.trees ?? TREES;
  const tree = treeFor(ref.file, trees);
  if (ref.kind === "module-self") {
    const expected = expectedModulePaths(ref.file, ctx.fs, trees);
    if (expected.has(ref.target)) return { status: "resolved", via: "location" };
    return { status: "unresolved", reason: `@module says "${ref.target}" but this file is "${[...expected][0] ?? ""}"` };
  }
  if (isMaintainerLocal(ref.target) && !ctx.devDocsPresent) {
    return { status: "skipped", reason: "maintainer-local target and dev-docs/ is absent" };
  }
  if (ref.target.includes("::")) return resolveRustModuleTarget(ref.target, ref, tree, ctx);
  return resolvePathTarget(ref.target, ref, tree, ctx);
}


/** Resolve one file's references: the unresolved ones, with the per-reference statistics recorded in `stats`. */
function scanFile(file, source, ctx, stats) {
  const findings = [];
  for (const ref of extractReferences(source, file)) {
    stats.references[ref.kind]++;
    const r = resolveReference(ref, ctx);
    if (r.status === "skipped") {
      stats.maintainerLocalSkipped++;
      continue;
    }
    if (isMaintainerLocal(ref.target)) stats.maintainerLocalChecked++;
    if (r.status === "resolved") stats.resolvedVia[r.via]++;
    else findings.push({ ...ref, key: identityKey(ref), reason: r.reason });
  }
  return findings;
}

/** Every unresolved reference under `root`, sorted by identity key, plus scan statistics. */
export function collectFindings(root, { trees = TREES } = {}) {
  const ctx = resolutionContext(root, trees);
  const stats = {
    files: 0,
    generatedSkipped: 0,
    references: Object.fromEntries(KINDS.map((k) => [k, 0])),
    resolvedVia: { location: 0, tail: 0, dependency: 0 },
    maintainerLocalSkipped: 0,
    maintainerLocalChecked: 0,
    devDocsPresent: ctx.devDocsPresent,
  };
  const findings = [];
  for (const tree of trees) {
    if (!ctx.fs.isDir(tree.dir)) continue;
    for (const file of walkSources(ctx.fs, tree.dir)) {
      const source = ctx.fs.read(file);
      if (isGenerated(source, file)) {
        stats.generatedSkipped++;
        continue;
      }
      stats.files++;
      findings.push(...scanFile(file, source, ctx, stats));
    }
  }
  findings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { findings, stats };
}

/**
 * Two-way identity comparison. `unlisted` fails (a new stale header), `stale`
 * fails (a fixed header still carried — record the win). `ignored` are
 * maintainer-local entries that cannot be verified because `dev-docs/` is absent.
 */
export function compareWithBaseline(findings, baseline, { devDocsPresent = true } = {}) {
  const actual = new Set(findings.map((f) => f.key ?? identityKey(f)));
  const listed = new Set(baseline.entries);
  const unlisted = [...actual].filter((k) => !listed.has(k)).sort();
  const gone = [...listed].filter((k) => !actual.has(k)).sort();
  const ignored = devDocsPresent ? [] : gone.filter(isMaintainerLocalKey);
  const stale = devDocsPresent ? gone : gone.filter((k) => !isMaintainerLocalKey(k));
  return { unlisted, stale, ignored };
}

/**
 * Validate a parsed baseline document; throws on anything but unique
 * `<file>|<kind>|<target>` strings with a non-empty file and target and a kind
 * from `KINDS` — an entry with a typo'd kind could never match a finding, and
 * would sit in the list as a stale entry nothing explains.
 */
export function validateBaseline(doc, label = "baseline") {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.entries)) throw new Error(`${label}: expected { "entries": [...] }`);
  const seen = new Set();
  for (const e of doc.entries) {
    const parts = typeof e === "string" ? e.split("|") : [];
    const [file, kind] = parts;
    const target = parts.slice(2).join("|");
    if (parts.length < 3 || !file || !target || !KINDS.includes(kind)) {
      throw new Error(`${label}: entry is not a "<file>|<kind>|<target>" key with a kind in ${KINDS.join("|")}: ${JSON.stringify(e)}`);
    }
    if (seen.has(e)) throw new Error(`${label}: duplicate entry ${e}`);
    seen.add(e);
  }
  return { entries: doc.entries };
}

export const BASELINE_HEADER = [
  "Header-reference identity baseline (WI-FL0.2): every header reference that did not resolve when this was measured, as <file>|<kind>|<target>.",
  "Checked by scripts/check-header-references.mjs (pnpm lint:header-refs, in check:static). Two-way: an unlisted finding fails, and a listed entry that no longer occurs fails until it is deleted (record the win).",
  "Entries only get REMOVED — fix the header (the target moved, was renamed or deleted); never append here. dev-docs/ entries are verified only where that directory exists.",
];

export function formatBaseline(entries) {
  return `${JSON.stringify({ "//": BASELINE_HEADER, entries: [...new Set(entries)].sort() }, null, 2)}\n`;
}
