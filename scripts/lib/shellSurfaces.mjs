/**
 * The surfaces `src/App.tsx` mounts inside `<AppShell>`: every component
 * element at any depth, minus the enumerated transparent wrappers and the
 * module-pinned non-surface bindings, by a real TSX parse.
 *
 * Purpose: the extraction half of the shell-slots identity gate. The SURFACE
 * definition and why each exclusion is enumerated rather than a namespace are
 * in the gate's header; the baseline comparison and the CLI live in the gate.
 *
 * @coordinates-with scripts/check-shell-slots.mjs — the gate (CLI) that re-exports this
 * @module scripts/lib/shellSurfaces
 */
import ts from "typescript";

/** The composition root the walk starts from. Absent → the gate fails closed. */
const SHELL_ROOT_TAG = "AppShell";
/** Render-children-unchanged wrappers: recursed through, never recorded. */
const TRANSPARENT_WRAPPERS = new Set(["Suspense", "FeatureErrorBoundary", "React.Fragment"]);
/**
 * The complete list of bindings excluded because of what they are, each pinned
 * to the module that must supply it. Enumerated, never a namespace prefix — see
 * the header. Removing a mount means deleting its entry here too.
 */
const NON_SURFACE_BINDINGS = new Map([
  ["EditorArea", { module: "@/shell", why: "ADR-007 shell frame — a frame is not a surface" }],
  ["DocumentWindowMount", { module: "@/hooks/lifecycle", why: "runs effects; mounts no UI" }],
  ["MainWindowRunners", { module: "@/hooks/lifecycle", why: "runs effects; mounts no UI" }],
]);

/** Dotted name of a JSX tag, or null for namespaced/exotic tags. */
function jsxTagName(tagName) {
  if (ts.isIdentifier(tagName)) return tagName.text;
  if (ts.isPropertyAccessExpression(tagName)) {
    const left = jsxTagName(tagName.expression);
    return left === null ? null : `${left}.${tagName.name.text}`;
  }
  return null;
}

/** local binding name → module specifier, for every import in the file. */
function importMapOf(sourceFile) {
  const map = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) map.set(clause.name.text, spec);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) map.set(bindings.name.text, spec);
    else for (const el of bindings.elements) map.set(el.name.text, spec);
  }
  return map;
}

/** Does `spec` name the module (or a subpath of it) an exclusion is pinned to? */
function providedBy(spec, module) {
  return spec === module || spec.startsWith(`${module}/`);
}

/** Allowlist entries whose binding this file no longer imports from its
 *  declared module — dead exclusions, which the gate refuses to carry. */
function staleExclusionsIn(imports) {
  const stale = [];
  for (const [name, { module }] of NON_SURFACE_BINDINGS) {
    const spec = imports.get(name);
    if (spec === undefined || !providedBy(spec, module)) {
      stale.push({ name, module, found: spec ?? null });
    }
  }
  return stale;
}

/**
 * Every surface mounted by the shell composition in `text` (sorted, unique),
 * plus any stale exclusion-allowlist entries.
 * Throws (fail closed) when the file does not parse or mounts no `<AppShell>`.
 */
export function extractShellSurfaces(text, label = "App.tsx") {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const parseErrors = sf.parseDiagnostics ?? [];
  if (parseErrors.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseErrors[0].messageText, " ");
    throw new Error(`${label} does not parse as TSX: ${first}`);
  }

  const roots = [];
  const findRoots = (node) => {
    if (ts.isJsxElement(node) && jsxTagName(node.openingElement.tagName) === SHELL_ROOT_TAG) {
      roots.push(node);
    } else if (ts.isJsxSelfClosingElement(node) && jsxTagName(node.tagName) === SHELL_ROOT_TAG) {
      roots.push(node);
    }
    ts.forEachChild(node, findRoots);
  };
  ts.forEachChild(sf, findRoots);

  if (roots.length === 0) {
    throw new Error(
      `${label} mounts no <${SHELL_ROOT_TAG}> element — the shell composition root ` +
        `moved or was renamed. The gate cannot enumerate surfaces and fails closed.`,
    );
  }

  const imports = importMapOf(sf);
  const surfaces = new Set();
  const record = (tagName) => {
    const name = jsxTagName(tagName);
    if (name === null || !/^[A-Z]/.test(name)) return; // host element / exotic tag
    if (name === SHELL_ROOT_TAG || TRANSPARENT_WRAPPERS.has(name)) return;
    const excluded = NON_SURFACE_BINDINGS.get(name.split(".")[0]);
    const spec = imports.get(name.split(".")[0]);
    // Both must hold: the NAME is allowlisted AND the module it came from is
    // the one the allowlist pinned it to. A same-named component from anywhere
    // else is an ordinary surface.
    if (excluded && spec !== undefined && providedBy(spec, excluded.module)) return;
    surfaces.add(name);
  };
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) record(node.tagName);
    ts.forEachChild(node, visit);
  };
  for (const root of roots) ts.forEachChild(root, visit);

  return {
    surfaces: [...surfaces].sort((a, b) => a.localeCompare(b)),
    staleExclusions: staleExclusionsIn(imports),
  };
}
