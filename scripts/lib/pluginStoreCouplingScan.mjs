/**
 * Measure plugin→host coupling: which plugin files import the app's stores,
 * services, hooks or components, by a real TypeScript parse of every module
 * specifier.
 *
 * Purpose: the measurement half of the store-coupling ratchet. The comparison
 * against the frozen baseline and the CLI live in the gate; why there are four
 * channels and why detection is an AST walk is in the gate's header.
 *
 * @coordinates-with scripts/check-plugin-store-coupling.mjs — the gate (CLI) that re-exports this
 * @module scripts/lib/pluginStoreCouplingScan
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** The four ways a plugin reaches the app, in report order. */
export const CHANNELS = ["stores", "services", "hooks", "components"];
const CHANNEL_SET = new Set(CHANNELS);

const SOURCE_EXT = /\.tsx?$/;
const TEST_FILE = /\.(test|spec)\.tsx?$/;

/** Recursively collect non-test `.ts`/`.tsx` files under `dir`. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "__mocks__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

function scriptKindFor(rel) {
  return rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Every module specifier a file imports from — static, type-only, dynamic
 * `import()`, re-export, and the `import("…")` type node.
 *
 * A real AST walk: a specifier in a comment or a plain string is not a module
 * specifier, so "parse, don't grep" holds by construction. That removes the
 * documented false positive where prose ABOUT the coupling counted AS coupling
 * (`.claude/rules/00-engineering-principles.md`).
 */
export function extractImportSpecifiers(text, rel) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindFor(rel));
  const specs = [];
  const push = (node) => {
    if (node && ts.isStringLiteralLike(node)) specs.push(node.text);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) push(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      push(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      push(node.arguments[0]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      push(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/**
 * Which channel a specifier reaches, or null.
 *
 * `fileRel` is the importing file's repo-relative path, needed because a
 * relative specifier climbing out of the plugin (`../../stores/tabStore`) is
 * the same coupling as `@/stores/tabStore` wearing a disguise.
 */
export function channelOf(spec, fileRel) {
  let resolved;
  if (spec.startsWith("@/")) resolved = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), spec));
  } else return null;

  const segments = resolved.split("/");
  if (segments[0] !== "src" || segments.length < 2) return null;
  return CHANNEL_SET.has(segments[1]) ? segments[1] : null;
}

/**
 * Measure current coupling.
 *
 * @returns `{ unit: { channel: [repo-relative file, …] } }` for units with at
 *   least one coupled file. Units and channels at zero are omitted, so a fully
 *   decoupled plugin drops out of the map and surfaces as a `fixed` violation
 *   against the baseline.
 */
export function scanCoupling(repoRoot) {
  const pluginsRoot = path.join(repoRoot, "src", "plugins");
  const found = {};
  if (!existsSync(pluginsRoot)) return found;

  for (const entry of readdirSync(pluginsRoot)) {
    const full = path.join(pluginsRoot, entry);
    const isDir = statSync(full).isDirectory();
    if (isDir ? entry === "__tests__" || entry === "__mocks__" : !SOURCE_EXT.test(entry) || TEST_FILE.test(entry)) {
      continue;
    }

    for (const file of isDir ? sourceFiles(full) : [full]) {
      const rel = path.relative(repoRoot, file).split(path.sep).join("/");
      const channels = new Set();
      for (const spec of extractImportSpecifiers(readFileSync(file, "utf8"), rel)) {
        const channel = channelOf(spec, rel);
        if (channel) channels.add(channel);
      }
      for (const channel of channels) {
        ((found[entry] ??= {})[channel] ??= []).push(rel);
      }
    }
  }

  return found;
}

/** Collapse the scan's file lists into the per-channel counts the baseline freezes. */
export function countsOf(scan) {
  const counts = {};
  for (const unit of Object.keys(scan).sort()) {
    counts[unit] = {};
    for (const channel of CHANNELS) {
      if (scan[unit][channel]?.length) counts[unit][channel] = scan[unit][channel].length;
    }
  }
  return counts;
}
