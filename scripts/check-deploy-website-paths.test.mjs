// WI-RA19.8 — the website redeploys when a source file it BUILDS FROM changes.
//
// deploy-website.yml triggers on a path list. The site's CJK demo imports the
// app's formatter from `src/lib/cjkFormatter/`, which the list did not name,
// so a formatter fix shipped in the app while vmark.app kept demonstrating the
// old behaviour until some unrelated website edit happened to redeploy it.
//
// The list is not trusted by reading it: this walks every runtime import that
// leaves `website/` (and everything those files import in turn) and requires
// each reached file to match a trigger path. A new cross-directory import
// with no trigger fails here, on the PR, instead of silently never deploying.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/deploy-website.yml";
const WEBSITE_SOURCES = "website/.vitepress";
const SOURCE_EXT = /\.(?:ts|mts|js|mjs|vue)$/;
const SKIP_DIRS = new Set(["node_modules", "cache", "dist"]);

const read = (rel) => readFileSync(join(root, rel), "utf8");
const isFile = (rel) => existsSync(join(root, rel)) && statSync(join(root, rel)).isFile();

/** The `on.push.paths` entries of the deploy workflow. */
function triggerPaths(yaml) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s+paths:\s*$/.test(l));
  if (start < 0) throw new Error(`${WORKFLOW}: no push paths list`);
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/);
    if (!m) break;
    paths.push(m[1]);
  }
  return paths;
}

/** Whether `file` matches a trigger path: an exact name, or a `dir/**` subtree. */
function covered(file, paths) {
  return paths.some((p) => (p.endsWith("/**") ? file.startsWith(p.slice(0, -2)) : file === p));
}

function sourceFiles(dirRel) {
  const out = [];
  for (const name of readdirSync(join(root, dirRel))) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = `${dirRel}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (SOURCE_EXT.test(name)) out.push(rel);
  }
  return out;
}

/** Relative runtime import specifiers of a source file (type-only ones erase at build). */
function relativeImports(source) {
  const found = [];
  const re = /^\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+["'](\.[^"']*)["']/gm;
  for (const m of source.matchAll(re)) if (m[1] === undefined) found.push(m[2]);
  return found;
}

function resolveImport(fromRel, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  const hit = [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.vue`, `${base}/index.ts`].find(isFile);
  if (hit === undefined) throw new Error(`${fromRel}: cannot resolve import "${spec}"`);
  return hit;
}

/** Every file outside `website/` that the site build reaches through relative imports. */
function filesOutsideWebsite() {
  const outside = new Set();
  const seen = new Set();
  const queue = sourceFiles(WEBSITE_SOURCES);
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.startsWith("website/")) outside.add(rel);
    for (const spec of relativeImports(read(rel))) {
      const target = resolveImport(rel, spec);
      if (SOURCE_EXT.test(target)) queue.push(target);
      else if (!target.startsWith("website/")) outside.add(target);
    }
  }
  return [...outside].sort();
}

describe("deploy-website trigger paths", () => {
  const paths = triggerPaths(read(WORKFLOW));

  it("parses the trigger list", () => {
    expect(paths).toContain("website/**");
    expect(paths).toContain("package.json");
  });

  it("the site build really does reach app sources (the walk is not vacuous)", () => {
    const outside = filesOutsideWebsite();
    expect(outside).toContain("src/lib/cjkFormatter/rules/applyRules.ts");
    expect(outside).toContain("src/lib/cjkFormatter/types.ts");
  });

  it("every file the site build imports from outside website/ triggers a deploy", () => {
    const untriggered = filesOutsideWebsite().filter((file) => !covered(file, paths));
    expect(untriggered).toEqual([]);
  });

  it("matches subtrees and exact names only", () => {
    expect(covered("src/lib/cjkFormatter/rules/a.ts", ["src/lib/cjkFormatter/**"])).toBe(true);
    expect(covered("src/lib/cjkFormatterX/a.ts", ["src/lib/cjkFormatter/**"])).toBe(false);
    expect(covered("package.json", ["package.json"])).toBe(true);
    expect(covered("src/package.json", ["package.json"])).toBe(false);
  });
});
