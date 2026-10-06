/**
 * The scanned tree behind the header-reference gate: which
 * directories are scanned, a memoised view of the filesystem under one root,
 * and the two indexes built over it once per run — every file and directory by
 * basename (for suffix matching) and every declared npm dependency.
 *
 * Purpose: target resolution (`headerReferenceTargets.mjs`) and reference
 * collection (`headerReferences.mjs`) must agree on one inventory of the tree;
 * this module is that inventory and nothing else — it decides no reference.
 *
 * @coordinates-with scripts/lib/headerReferenceTargets.mjs — resolves targets against these indexes
 * @coordinates-with scripts/lib/headerReferences.mjs — walks these trees and builds the context
 * @coordinates-with scripts/check-header-references.test.mjs — drives each rule through the gate
 * @module scripts/lib/headerReferenceTrees
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const posix = path.posix;

/** Scan roots. `moduleBase` is what `@module` paths are relative to. */
export const TREES = [
  { dir: "src", moduleBase: "src", packageRoot: ".", lang: "ts" },
  { dir: "src-tauri/src", moduleBase: "src-tauri/src", packageRoot: "src-tauri", lang: "rust" },
  { dir: "server/mcp/src", moduleBase: "server/mcp/src", packageRoot: "server/mcp", lang: "ts" },
  { dir: "server/content/src", moduleBase: "server/content/src", packageRoot: "server/content", lang: "ts" },
  { dir: "scripts", moduleBase: ".", packageRoot: ".", lang: "ts" },
  { dir: ".claude/hooks", moduleBase: ".", packageRoot: ".", lang: "ts" },
  { dir: "e2e", moduleBase: ".", packageRoot: ".", lang: "ts" },
];
// `.sh` is NOT scanned, and that is a KNOWN GAP, not an oversight: the DoD
// checkers and `lib/dod-assertions.sh` do carry `# Plan:` and
// `# @coordinates-with` headers. Adding `.sh` here (with the `#`-comment
// branch in headerComments.mjs, which exists) was measured and
// immediately reports TWELVE `# Plan: dev-docs/plans/*.md` headers whose plan
// file is no longer in this tree. Every one is MAINTAINER-LOCAL: `dev-docs/`
// is gitignored, so CI (where it is absent) skips them and only a maintainer
// machine sees them — and whether those plans are retired (rewrite the header
// as `Origin: … (retired)`) or merely missing from one checkout is a
// maintainer's call, not a gate's. Landing the scan needs that call first;
// appending them to the identity baseline is not an option, since its header
// forbids appending.
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".rs"]);
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "target", "coverage", ".git", "generated"]);
/** Tried, in order, when a path target has no extension of its own. */
export const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".rs", ".d.ts"];
export const RUST_ROOT = "src-tauri/src";
const RUST_DIR_FILES = new Set(["mod.rs", "lib.rs", "main.rs"]);
const MANIFEST_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Memoised lstat over one root: `kind(rel)` is "file" | "dir" | "link" | "none".
 * A symlink is never traversed or indexed — a link into `.` would recurse
 * forever, one out of the root would scan files outside it — but a header may
 * still legitimately name one, so it EXISTS without being a file or directory.
 */
export function fsAt(root) {
  const cache = new Map();
  const kind = (rel) => {
    if (!cache.has(rel)) {
      const s = lstatSync(path.join(root, rel), { throwIfNoEntry: false });
      cache.set(rel, !s ? "none" : s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "none");
    }
    return cache.get(rel);
  };
  return {
    exists: (rel) => kind(rel) !== "none",
    isDir: (rel) => kind(rel) === "dir",
    isFile: (rel) => kind(rel) === "file",
    listDir: (rel) => readdirSync(path.join(root, rel)),
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
  };
}

/** The scan tree a repo-relative file belongs to (longest matching root). */
export function treeFor(file, trees = TREES) {
  let best = null;
  for (const tree of trees) {
    if ((file === tree.dir || file.startsWith(`${tree.dir}/`)) && (!best || tree.dir.length > best.dir.length)) best = tree;
  }
  if (best) return best;
  return { dir: posix.dirname(file), moduleBase: ".", packageRoot: ".", lang: file.endsWith(".rs") ? "rust" : "ts" };
}

export function stripExtension(rel) {
  if (rel.endsWith(".d.ts")) return rel.slice(0, -5);
  const ext = posix.extname(rel);
  return ext ? rel.slice(0, -ext.length) : rel;
}

export const isRustDirFile = (file) => RUST_DIR_FILES.has(posix.basename(file));

/** Source files under `dir`, repo-relative, skipping `SKIP_SEGMENTS`. */
export function* walkSources(fs, dir) {
  for (const name of fs.listDir(dir).sort()) {
    if (SKIP_SEGMENTS.has(name)) continue;
    const rel = posix.join(dir, name);
    if (fs.isDir(rel)) yield* walkSources(fs, rel);
    else if (fs.isFile(rel) && SOURCE_EXTENSIONS.has(posix.extname(rel))) yield rel;
  }
}

/**
 * The extensions a target may grow when resolving it — `RESOLVE_EXTENSIONS` for
 * an EXTENSIONLESS file target, none otherwise.
 *
 * ONE rule, one place. It was written twice (here for the tail index, and in
 * `pathExistsAt` in headerReferenceTargets.mjs for location resolution), and the pair had already had the
 * same bug fixed in both copies: appending variants unconditionally let a
 * missing `foo.js` resolve through a `foo.js.ts` that exists for other reasons.
 * Two copies of a resolution rule are two
 * resolvers, and only one of them gets the next fix.
 */
export function extensionCandidates(spec, dirOnly) {
  return dirOnly || posix.extname(spec) !== "" ? [] : RESOLVE_EXTENSIONS;
}

/** Every file and directory under the scan trees, keyed by basename, for suffix matching. */
export function buildTailIndex(fs, trees = TREES) {
  const byName = new Map();
  const add = (p, isDir) => {
    const name = posix.basename(p);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ path: p, isDir });
  };
  const visit = (dir) => {
    for (const name of fs.listDir(dir)) {
      if (SKIP_SEGMENTS.has(name)) continue;
      const rel = posix.join(dir, name);
      if (fs.isDir(rel)) {
        add(rel, true);
        visit(rel);
      } else if (fs.isFile(rel)) add(rel, false);
    }
  };
  for (const tree of trees) if (fs.isDir(tree.dir)) visit(tree.dir);
  return {
    /** Some indexed path IS `spec` or ends with `/<spec>` (extension variants when spec has none). */
    hasTail(spec, dirOnly) {
      const variants = [spec, ...extensionCandidates(spec, dirOnly).map((e) => spec + e)];
      return variants.some((v) =>
        (byName.get(posix.basename(v)) ?? []).some((e) => (!dirOnly || e.isDir) && (e.path === v || e.path.endsWith(`/${v}`))),
      );
    },
  };
}

/** Package names declared by the root manifest and every tree's package manifest. */
export function dependencyNames(fs, trees = TREES) {
  const names = new Set();
  for (const dir of new Set([".", ...trees.map((t) => t.packageRoot)])) {
    const manifest = posix.join(dir, "package.json");
    if (!fs.isFile(manifest)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.read(manifest));
    } catch (err) {
      // A manifest this gate cannot read would turn every dependency-shaped
      // target into an "unresolved" finding — or into silence, if none is
      // referenced. Neither is what happened; say what did.
      throw new Error(`${manifest}: cannot parse package manifest — ${err.message}`);
    }
    for (const key of MANIFEST_KEYS) for (const name of Object.keys(pkg[key] ?? {})) names.add(name);
  }
  return names;
}
