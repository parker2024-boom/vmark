/**
 * Purpose: decide whether a relative mock (`vi.mock("./x")`, `vi.mock("../x")`)
 * replaces the app's own logic — the anti-pattern `.claude/rules/10-tdd.md`
 * names — or a module that wraps a real boundary, which is the sanctioned
 * thing to mock. An `@/` alias that names a module in the test's own
 * directory (or the one its `__tests__/` folder sits in) is the same sibling
 * spelled another way, and is judged the same.
 *
 * The boundary test is structural, not a hand list: a module is a boundary
 * wrapper when it imports `@tauri-apps/*` or a Node builtin itself (static
 * import, re-export, dynamic `import()` or `require()`). Anything else that
 * resolves to code is the subject's own logic. Non-code targets (CSS, raw
 * assets) carry no logic and are not this rule's concern. A relative code
 * target that resolves to no file is reported, never skipped: "cannot read"
 * is not "cleared".
 *
 * @coordinates-with scripts/check-mock-boundaries.mjs — the gate that applies this rule
 * @coordinates-with scripts/check-mock-boundaries.siblings.test.mjs — the fixture-tree self-test
 * @module scripts/lib/mockBoundaries/siblingMocks
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { scriptKindFor } from "./mockCalls.mjs";

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const CANDIDATE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
/** A TS-ESM specifier names the emitted file (`./x.js`) for a `./x.ts` source. */
const EMITTED_TO_SOURCE = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] };
const BUILTINS = new Set(builtinModules);

const isFile = (full) => existsSync(full) && statSync(full).isFile();

/** Is this import specifier a boundary: Tauri or a Node builtin? */
function isBoundarySpecifier(spec) {
  if (spec.startsWith("@tauri-apps/")) return true;
  if (spec.startsWith("node:")) return true;
  return BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]);
}

/**
 * Resolve a relative mock specifier against the repository. Returns
 * `{ kind: "code", target, rel }` (target = repo path without extension, rel =
 * the module file), `{ kind: "missing", target }` for a code-shaped specifier
 * that names no file, or `{ kind: "not-code" }` for CSS and other assets
 * (an existing non-code file, or an asset extension even when the file is not
 * on disk — a stylesheet mock needs no stylesheet).
 */
function resolveSiblingTarget(spec, fileRel, root) {
  const bare = spec.replace(/[?#].*$/, "");
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), bare));
  const ext = path.posix.extname(joined);
  const candidates = [];
  if (CODE_EXT.test(joined)) {
    candidates.push(joined);
    const stem = joined.slice(0, -ext.length);
    for (const e of EMITTED_TO_SOURCE[ext] ?? []) candidates.push(stem + e);
  }
  for (const e of CANDIDATE_EXTS) candidates.push(joined + e);
  for (const e of CANDIDATE_EXTS) candidates.push(`${joined}/index${e}`);
  const rel = candidates.find((c) => isFile(path.join(root, c)));
  if (rel === undefined) {
    // `./x.css`, `./x.svg?raw`: an asset. `./x.tiptap` is a dotted module
    // name and only reaches here when no `x.tiptap.ts` exists — still code.
    const isAsset = ext !== "" && !CODE_EXT.test(joined) && isFile(path.join(root, joined));
    const looksLikeAsset = /^\.(css|scss|svg|png|jpe?g|gif|webp|json|wasm|woff2?|ttf|html|md|txt)$/.test(ext);
    if (isAsset || looksLikeAsset) return { kind: "not-code" };
    return { kind: "missing", target: joined.replace(CODE_EXT, "") };
  }
  return { kind: "code", target: rel.replace(CODE_EXT, ""), rel };
}

/** Every module specifier a source file loads: static, re-export, `import()`, `require()`. */
function importedSpecifiers(text, rel) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindFor(rel));
  const out = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isDynamicImport || isRequire) out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** A module that itself imports a boundary is a boundary wrapper. */
function isBoundaryModule(text, rel) {
  return importedSpecifiers(text, rel).some(isBoundarySpecifier);
}

/** The directory whose modules are a test's siblings: its own, or the one its `__tests__/` folder sits in. */
function subjectDir(fileRel) {
  const dir = path.posix.dirname(fileRel);
  const at = dir.indexOf("/__tests__");
  return at === -1 ? dir : dir.slice(0, at);
}

/** The relative spelling of an `@/` specifier naming a module in the test's subject directory, else null. */
function aliasAsSibling(spec, fileRel) {
  if (!spec.startsWith("@/")) return null;
  const target = path.posix.normalize(path.posix.join("src", spec.slice(2)));
  if (path.posix.dirname(target) !== subjectDir(fileRel)) return null;
  const relative = path.posix.relative(path.posix.dirname(fileRel), target);
  return relative.startsWith("../") ? relative : `./${relative}`;
}

/**
 * The sibling-logic mock triple for one relative (or sibling-naming `@/`)
 * mock, or null when it is not one (not a sibling, not code, or a boundary
 * wrapper). Store targets are the caller's to exclude first — they have their
 * own list.
 */
export function siblingLogicTarget(rawSpec, fileRel, root) {
  const spec = aliasAsSibling(rawSpec, fileRel) ?? rawSpec;
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const resolved = resolveSiblingTarget(spec, fileRel, root);
  if (resolved.kind === "not-code") return null;
  if (resolved.kind === "missing") return resolved.target;
  const text = readFileSync(path.join(root, resolved.rel), "utf8");
  return isBoundaryModule(text, resolved.rel) ? null : resolved.target;
}
