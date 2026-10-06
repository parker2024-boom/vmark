/**
 * Purpose: find the `vi.mock` / `vi.doMock` calls in one test file and read
 * the module specifier each one targets — the parsing half of the
 * mock-boundary gate, shared by its store-mock and sibling-mock rules.
 *
 * Detection is a real TypeScript parse (AST call expressions), so a literal in
 * a comment or a plain string is prose, not a mock. The vitest receiver is
 * resolved through the file's own `vitest` import (`vi as v`, `import * as
 * vitest`), and a target that cannot be read is reported as
 * `UNRESOLVED_TARGET` rather than skipped.
 *
 * @coordinates-with scripts/check-mock-boundaries.mjs — the gate that consumes these calls
 * @module scripts/lib/mockBoundaries/mockCalls
 */
import ts from "typescript";

export function scriptKindFor(rel) {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(ts|mts|cts)$/.test(rel)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** Recorded instead of a module path when the target cannot be read. The text
 *  IS the instruction — it is what the failure message prints. */
export const UNRESOLVED_TARGET = "<non-literal mock target — use a string literal>";

/**
 * Same-file `const X = "…"` bindings, so a constant-backed target
 * (`vi.mock(STORE_PATH)`) resolves. A name bound more than once to different
 * text maps to null: ambiguous, therefore unresolvable, therefore a violation.
 */
function stringBindingsOf(sf) {
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      const value = ts.isStringLiteralLike(init) ? init.text : null;
      const name = node.name.text;
      if (bindings.has(name) && bindings.get(name) !== value) bindings.set(name, null);
      else bindings.set(name, value);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      // Reassignment makes the binding ambiguous regardless of the new value.
      bindings.set(node.left.text, null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bindings;
}

/** Local names that stand for vitest's `vi`, plus vitest namespace imports.
 *  `vi` itself is always recognized — `globals: true` needs no import. */
function vitestReceiversOf(sf) {
  const direct = new Set(["vi"]);
  const namespaces = new Set();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== "vitest") continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else {
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === "vi") direct.add(el.name.text);
      }
    }
  }
  return { direct, namespaces };
}

/** Is this call expression `<vi>.mock(…)` / `<vi>.doMock(…)`? Returns the
 *  canonical api label (never the alias — identity must not fork). */
function mockApiOf(node, { direct, namespaces }) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.text;
  if (method !== "mock" && method !== "doMock") return null;
  const recv = node.expression.expression;
  const isVi =
    (ts.isIdentifier(recv) && direct.has(recv.text)) ||
    (ts.isPropertyAccessExpression(recv) &&
      recv.name.text === "vi" &&
      ts.isIdentifier(recv.expression) &&
      namespaces.has(recv.expression.text));
  return isVi ? `vi.${method}` : null;
}

/** The first argument's module specifier: a string literal, the string inside
 *  the `vi.mock(import("…"))` dynamic form, or a same-file const bound to one.
 *  Anything else returns UNRESOLVED_TARGET — the gate fails closed rather than
 *  skipping a target it cannot read. */
function specifierOf(call, bindings) {
  const arg = call.arguments[0];
  if (!arg) return UNRESOLVED_TARGET;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isIdentifier(arg)) return bindings.get(arg.text) ?? UNRESOLVED_TARGET;
  if (ts.isCallExpression(arg) && arg.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const inner = arg.arguments[0];
    if (inner && ts.isStringLiteralLike(inner)) return inner.text;
    if (inner && ts.isIdentifier(inner)) return bindings.get(inner.text) ?? UNRESOLVED_TARGET;
  }
  return UNRESOLVED_TARGET;
}

/** Parse one file and return its `vi.mock`/`vi.doMock` calls as
 *  { api, spec } pairs. A real AST walk: comments and plain strings cannot
 *  produce a CallExpression, so "parse, don't grep" holds by construction. */
export function extractMockCalls(text, rel) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindFor(rel));
  const bindings = stringBindingsOf(sf);
  const receivers = vitestReceiversOf(sf);
  const calls = [];
  const visit = (node) => {
    const api = mockApiOf(node, receivers);
    if (api !== null) calls.push({ api, spec: specifierOf(node, bindings) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}
