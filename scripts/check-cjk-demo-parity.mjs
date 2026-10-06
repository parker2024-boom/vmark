#!/usr/bin/env node
/**
 * The website's CJK demo runs the APP's formatter rule chain, not a copy of it.
 * This asserts that it still does, and that the site build can still load it.
 *
 * The demo used to carry an ~800-line hand-maintained fork of
 * `src/lib/cjkFormatter/`, guarded only by a comparison of the settings
 * defaults. The defaults matched while the behaviour drifted: the fork kept
 * bugs the app had fixed (currency and unit binding that joined paragraphs,
 * ASCII-only Latin, BMP-only Han), so the page that tells a reader what the
 * app does showed output the app no longer produces. Comparing two
 * implementations' behaviour would be a second implementation of the
 * pipeline; deleting the second implementation is the fix that cannot drift.
 *
 * Why the demo can import the real module: the rule chain
 * (`rules/applyRules.ts` and what it imports) has exactly one runtime import
 * outside the formatter, `@/utils/debug`, which reaches `@tauri-apps/plugin-log`.
 * A Vite plugin in the site config answers exactly that specifier with a
 * console-only stand-in and nothing else, so any OTHER `@/` import fails the
 * site build.
 * The site build runs only on deploy, after merge — so this gate, which runs
 * in `check:static` on every PR, walks the rule chain's import graph and
 * fails the moment it gains an app import the site does not stand in for.
 *
 * Checks, all zero-tolerance:
 *   1. every runtime `@/` import reachable from `RULES_ENTRY` through relative
 *      imports is in `SITE_ALIASES`, and the site config names each one;
 *   2. the demo component imports `applyRules` and `DEFAULT_CJK_FORMATTING`
 *      from the app's `src/lib/cjkFormatter/`;
 *   3. no module under `website/.vitepress` declares its own `applyRules`, a
 *      `defaultCJKSettings`, or a `DEFAULT_CJK_FORMATTING` — a fork.
 *
 * Fails closed: an unreadable file or an unresolvable relative import is a
 * finding. Exit 0 clean, 1 findings.
 *
 * Usage: node scripts/check-cjk-demo-parity.mjs
 *
 * @coordinates-with website/.vitepress/config/shared.ts — the `@/utils/debug` stand-in
 * @coordinates-with website/.vitepress/components/demos/CJKFormatDemo.vue — the demo
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";
import { isMainModule } from "./lib/isMainModule.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const RULES_ENTRY = "src/lib/cjkFormatter/rules/applyRules.ts";
export const DEMO_COMPONENT = "website/.vitepress/components/demos/CJKFormatDemo.vue";
export const SITE_CONFIG = "website/.vitepress/config/shared.ts";
/** The app specifiers the site's Vite config answers with a website stand-in. */
export const SITE_ALIASES = ["@/utils/debug"];

const WEBSITE_SOURCES = "website/.vitepress";
const SOURCE_EXT = /\.(?:ts|mts|js|mjs|vue)$/;

/**
 * Every `import … from "x"` / `export … from "x"`, with whether it is
 * type-only. The `[^;]*?` spans multi-line import lists; statements end at
 * the specifier's closing quote.
 */
function importSpecifiers(source) {
  const found = [];
  const re = /^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/gm;
  for (const m of source.matchAll(re)) found.push({ spec: m[3], typeOnly: m[2] !== undefined });
  return found;
}

/**
 * `./x` from `dir/file.ts` → `dir/x`, `dir/x.ts` or `dir/x/index.ts`, whichever
 * exists. `read` returns `undefined` for a missing file; none existing throws.
 */
function resolveRelative(fromRel, spec, read) {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  const found = [base, `${base}.ts`, `${base}/index.ts`].find((c) => read(c) !== undefined);
  if (found === undefined) throw new Error(`${fromRel}: cannot resolve import "${spec}"`);
  return found;
}

/** A file's text; a missing one throws, so the gate fails closed. */
function mustRead(read, rel) {
  const source = read(rel);
  if (source === undefined) throw new Error(`cannot read ${rel}`);
  return source;
}

/** Runtime `@/` specifiers reachable from `entry` by following relative imports. */
export function runtimeAppImports(entry, read) {
  const appImports = new Set();
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const { spec, typeOnly } of importSpecifiers(mustRead(read, rel))) {
      if (typeOnly) continue;
      if (spec.startsWith("@/")) appImports.add(spec);
      else if (spec.startsWith(".")) queue.push(resolveRelative(rel, spec, read));
    }
  }
  return appImports;
}

/** The demo component must take both names from the app's formatter. */
export function demoImportFailures(vueSource) {
  const failures = [];
  const wanted = [
    ["applyRules", "src/lib/cjkFormatter/rules/applyRules"],
    ["DEFAULT_CJK_FORMATTING", "src/lib/cjkFormatter/types"],
  ];
  for (const [name, target] of wanted) {
    const re = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`);
    const m = re.exec(vueSource);
    if (!m || !m[1].endsWith(target)) {
      failures.push(`${DEMO_COMPONENT} does not import \`${name}\` from the app's ${target}.ts`);
    }
  }
  return failures;
}

/** A website module that declares the rule chain or a settings literal is a fork. */
export function forkFailures(files) {
  const decl = /\b(?:function|const|let|var)\s+(applyRules|defaultCJKSettings|DEFAULT_CJK_FORMATTING)\b/;
  const failures = [];
  for (const [rel, source] of files) {
    const m = decl.exec(source);
    if (m) failures.push(`${rel} declares its own \`${m[1]}\`: the demo must import the app's formatter, not fork it`);
  }
  return failures;
}

/** All findings for one tree. `read(rel)` returns a file's text, or `undefined` when it is absent. */
export function checkTree(read, websiteFiles) {
  const failures = [];
  const config = mustRead(read, SITE_CONFIG);
  for (const spec of runtimeAppImports(RULES_ENTRY, read)) {
    if (!SITE_ALIASES.includes(spec)) {
      failures.push(`the CJK rule chain imports \`${spec}\`, which the website build cannot resolve (it stands in only for ${SITE_ALIASES.join(", ")})`);
    }
  }
  for (const spec of SITE_ALIASES) {
    if (!config.includes(`"${spec}"`)) failures.push(`${SITE_CONFIG} does not stand in for \`${spec}\``);
  }
  failures.push(...demoImportFailures(mustRead(read, DEMO_COMPONENT)));
  failures.push(...forkFailures(websiteFiles));
  return failures;
}

function listWebsiteSources(dirRel) {
  const out = [];
  for (const entry of readdirSync(join(root, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "cache" || entry.name === "node_modules") continue;
      out.push(...listWebsiteSources(rel));
    } else if (SOURCE_EXT.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function main() {
  const read = (rel) => {
    const abs = join(root, rel);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : undefined;
  };
  let failures;
  try {
    failures = checkTree(read, listWebsiteSources(WEBSITE_SOURCES).map((rel) => [rel, mustRead(read, rel)]));
  } catch (error) {
    console.error(`\n❌ CJK demo parity could not be checked: ${error.message}\n`);
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error("\n❌ The website's CJK demo no longer runs the app's formatter:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "\nImport the app's module in the demo rather than copying it. If the rule chain\n" +
        "needs a new app import, give it a stand-in in the site's Vite config and add\n" +
        "it to SITE_ALIASES here.\n"
    );
    process.exit(1);
  }
  console.log("✅ The website's CJK demo runs the app's formatter.");
}

if (isMainModule(import.meta.url)) main();
