/**
 * Header-reference TARGET resolution — does the thing a header
 * names exist? The grammar that finds the references lives in
 * `scripts/lib/headerComments.mjs`; this module answers for one target.
 *
 * Purpose: one place that knows every base a reader could mean by a header
 * path, so the gate flags a target that MOVED, was RENAMED or was DELETED and
 * nothing else. Measured on adoption (4,700 references): 192 of 255 bare-name
 * targets named a file living in another directory (`settingsStore.ts` from a
 * hook), so a bare name or partial path is resolved by PATH SUFFIX over the
 * scan trees after the location-based bases fail — that is the convention the
 * repo actually uses, and a moved file with an unchanged tail is the one class
 * this trades away (reported per run so the trade stays visible).
 *
 * Key decisions:
 *   - Bases, in order: the file's directory, each ancestor up to its tree
 *     root, `src/`, `src-tauri/src/`, the tree's PACKAGE root (`src-tauri/`,
 *     `server/mcp/`) and the repo root. Cross-language references
 *     (`hooks/useTheme.ts` from Rust, `pdf_export/commands.rs` from TS) are
 *     ordinary here, so the two source roots apply to every tree.
 *   - A bare directory resolves (which subsumes `/index.ts` and `/mod.rs`);
 *     a trailing `/` demands one. Extensionless targets try
 *     `RESOLVE_EXTENSIONS`. `a/{b,c}.ts` must resolve for EVERY alternative;
 *     a `*` glob resolves when at least one file matches.
 *   - `./`, `../` and `@/` targets are anchored: no suffix fallback.
 *   - A target naming a declared npm dependency (`@tauri-apps/plugin-log`)
 *     resolves against the manifests, not `node_modules`, so no install is
 *     needed to check it.
 *   - Rust `a::b::c` resolves to `a/b/c.rs` or `a/b/c/mod.rs` under
 *     `src-tauri/src/`, the file's own module directory, or its directory;
 *     `crate::`, `self::` and `super::` are honoured.
 *
 * @coordinates-with scripts/lib/headerReferences.mjs — the grammar; calls these per reference
 * @coordinates-with scripts/lib/headerReferenceTrees.mjs — the scanned trees and the indexes resolved against
 * @coordinates-with scripts/check-header-references.test.mjs — drives each resolution rule
 * @module scripts/lib/headerReferenceTargets
 */
import path from "node:path";

import { RESOLVE_EXTENSIONS, RUST_ROOT, extensionCandidates, isRustDirFile, stripExtension } from "./headerReferenceTrees.mjs";

// The tree inventory lives in its own module. The constants and lookups a
// resolution rule is stated in terms of stay importable from here.
export { RESOLVE_EXTENSIONS, RUST_ROOT, fsAt, treeFor } from "./headerReferenceTrees.mjs";

const posix = path.posix;

/** `tools/{a,b}.ts` → `["tools/a.ts", "tools/b.ts"]`; no braces → `[target]`. */
export function expandBraces(target) {
  const m = /^([^{]*)\{([^{}]*)\}(.*)$/.exec(target);
  if (!m) return [target];
  return m[2].split(",").flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Number of entries under `base` matching a `*`-glob path, segment by segment.
 * `require` constrains the FINAL frontier to `"file"` or `"dir"`: the module
 * header's contract is that "a `*` glob resolves when at least one FILE
 * matches", and counting every entry let `foo/*.ts` resolve through a
 * DIRECTORY named `x.ts` — while a glob with a trailing slash, which asks for
 * a directory, accepted a file.
 *
 * A segment holding no `*` is PATH ARITHMETIC, not a directory entry: `readdir`
 * never lists `.` or `..`, so an anchored glob (`./foo/*.ts`, `../foo/*.ts`)
 * matched nothing at its very first segment and could never resolve.
 */
export function globHits(fs, base, pattern, { require } = {}) {
  let frontier = [posix.normalize(base)];
  for (const seg of pattern.split("/").filter(Boolean)) {
    const next = [];
    if (seg.includes("*")) {
      const re = new RegExp(`^${seg.split("*").map(escapeRe).join(".*")}$`);
      for (const dir of frontier) {
        if (!fs.isDir(dir)) continue;
        for (const name of fs.listDir(dir)) if (re.test(name)) next.push(posix.join(dir, name));
      }
    } else {
      for (const dir of frontier) {
        const rel = posix.normalize(posix.join(dir, seg));
        if (!escapesRoot(rel) && fs.exists(rel)) next.push(rel);
      }
    }
    frontier = next;
    if (frontier.length === 0) return 0;
  }
  if (require === "file") frontier = frontier.filter((rel) => fs.isFile(rel));
  else if (require === "dir") frontier = frontier.filter((rel) => fs.isDir(rel));
  return frontier.length;
}

const uniq = (xs) => [...new Set(xs)];
const isAnchored = (t) => t.startsWith("./") || t.startsWith("../") || t.startsWith("@/");
/** A normalised path that climbs out of the root — by SEGMENT, so `..config` is an ordinary name. */
const escapesRoot = (rel) => rel === ".." || rel.startsWith("../");

/** Directories a path target is tried against, in the order a reader would. */
export function resolutionBases(target, file, tree) {
  const dir = posix.dirname(file);
  if (target.startsWith("./") || target.startsWith("../")) return [dir];
  if (target.startsWith("@/")) return uniq(["src", tree.dir]);
  const bases = [];
  let d = dir;
  while (true) {
    bases.push(d);
    if (d === tree.dir || d === "." || !d.startsWith(tree.dir)) break;
    d = posix.dirname(d);
  }
  bases.push("src", RUST_ROOT, tree.packageRoot, ".");
  return uniq(bases);
}

function pathExistsAt(fs, base, spec, dirOnly) {
  const rel = posix.normalize(posix.join(base, spec));
  if (escapesRoot(rel)) return false;
  if (dirOnly) return fs.isDir(rel);
  if (fs.exists(rel)) return true;
  return extensionCandidates(spec, dirOnly).some((ext) => fs.isFile(rel + ext));
}

/**
 * The root PACKAGE a module specifier names: `@tauri-apps/api/core` →
 * `@tauri-apps/api`, `yaml/util` → `yaml`. A manifest declares the package,
 * never its subpaths, so an exact-key lookup rejected every deep import a
 * header could legitimately name.
 */
function packageRoot(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * How each brace alternative resolved, weakest LAST: the route reported for the
 * whole target is the one worth knowing about, not whichever alternative
 * happened to come last. A single mutable `via` made the provenance
 * order-dependent, so `{a,b}` where `a` needed the suffix fallback and `b` was
 * a dependency reported "dependency" and hid the trade the header says is
 * reported per run.
 */
const VIA_RANK = { tail: 2, dependency: 1, location: 0 };

/**
 * Resolve a path-shaped target. `ctx` is `{ fs, index, deps }`. Returns
 * `{ status: "resolved", via: "location" | "tail" | "dependency" }` or
 * `{ status: "unresolved", reason }`.
 */
export function resolvePathTarget(target, ref, tree, ctx) {
  const dirOnly = target.endsWith("/");
  const routes = ["location"];
  for (const variant of expandBraces(target.replace(/\/+$/, ""))) {
    const spec = variant.startsWith("@/") ? variant.slice(2) : variant;
    const bases = resolutionBases(variant, ref.file, tree);
    const isGlob = spec.includes("*");
    const globRequire = dirOnly ? "dir" : "file";
    if (bases.some((b) => (isGlob ? globHits(ctx.fs, b, spec, { require: globRequire }) > 0 : pathExistsAt(ctx.fs, b, spec, dirOnly)))) continue;
    if (!isGlob && !isAnchored(variant) && ctx.index.hasTail(spec, dirOnly)) {
      routes.push("tail");
      continue;
    }
    if (!dirOnly && !isGlob && (ctx.deps.has(variant) || ctx.deps.has(packageRoot(variant)))) {
      routes.push("dependency");
      continue;
    }
    const what = isGlob ? (dirOnly ? "no directory matches" : "no file matches") : dirOnly ? "no directory" : "no file, directory or dependency";
    return { status: "unresolved", reason: `${what} "${variant}" from ${bases.join(", ")}` };
  }
  return { status: "resolved", via: routes.reduce((a, b) => (VIA_RANK[b] > VIA_RANK[a] ? b : a)) };
}

/** The directory a Rust file's OWN submodules live in. */
export function rustModuleDir(file) {
  const dir = posix.dirname(file);
  return isRustDirFile(file) ? dir : posix.join(dir, stripExtension(posix.basename(file)));
}

/** `a::b::c` → `a/b/c.rs` | `a/b/c/mod.rs` | a directory, under the Rust bases. */
export function resolveRustModuleTarget(target, ref, tree, ctx) {
  const segs = target.split("::").filter(Boolean);
  const modDir = tree.lang === "rust" ? rustModuleDir(ref.file) : posix.dirname(ref.file);
  let bases;
  if (segs[0] === "crate") {
    segs.shift();
    bases = [RUST_ROOT];
  } else if (segs[0] === "self") {
    segs.shift();
    bases = [modDir];
  } else if (segs[0] === "super") {
    let b = modDir;
    while (segs[0] === "super") {
      // `super` climbs one module; it cannot climb out of the crate root, so a
      // chain that would is unresolved rather than a match on whatever
      // repository file happens to sit above `src-tauri/src`.
      if (b === RUST_ROOT || !b.startsWith(`${RUST_ROOT}/`)) {
        return { status: "unresolved", reason: `"${target}": a super:: climbs above ${RUST_ROOT}` };
      }
      segs.shift();
      b = posix.dirname(b);
    }
    bases = [b];
  } else {
    bases = uniq([RUST_ROOT, modDir, posix.dirname(ref.file)]);
  }
  // `crate::`, `self::`, `super::super::` — a qualifier with no module after
  // it names nothing. The empty relative path used to join to the base itself,
  // which is a directory that exists, so a prefix-only target "resolved".
  if (segs.length === 0) {
    return { status: "unresolved", reason: `"${target}": names no module after its qualifier` };
  }
  const rel = segs.join("/");
  const hit = bases.some((b) => {
    const p = posix.normalize(posix.join(b, rel));
    return !escapesRoot(p) && (ctx.fs.isFile(`${p}.rs`) || ctx.fs.isFile(`${p}/mod.rs`) || ctx.fs.isDir(p));
  });
  if (hit) return { status: "resolved", via: "location" };
  return { status: "unresolved", reason: `no module "${target}" (${rel}.rs or ${rel}/mod.rs) under ${bases.join(", ")}` };
}
