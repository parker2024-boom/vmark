/**
 * Purpose: the TypeScript / JavaScript probes behind `scripts/dod-syntax.mjs` —
 *   a source reduced to its CODE (literals and comments blanked through the
 *   compiler's parser), and the count of runnable test cases a file declares.
 *
 * @coordinates-with scripts/dod-syntax.mjs — the CLI these answer for
 * @coordinates-with scripts/lib/dodSyntaxJourney.mjs — the journey-shape probe over the same parse
 * @module scripts/lib/dodSyntaxTs
 */
import ts from "typescript";

export function parseSource(file, source) {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.(m?js|cjs|jsx)$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

const TS_LITERAL_KINDS = [
  ts.isStringLiteral,
  ts.isNoSubstitutionTemplateLiteral,
  ts.isTemplateHead,
  ts.isTemplateMiddle,
  ts.isTemplateTail,
  ts.isRegularExpressionLiteral,
  ts.isJsxText,
];

/**
 * `source` reduced to what TypeScript reads as CODE, offsets and newlines
 * preserved. Two passes, in this order because the second depends on the
 * first: every LITERAL is blanked through the parser (which is the only thing
 * that can tell a regex from a division and find the ends of a nested
 * template), and then — with no literal left to hide one — `//` and block
 * comments are blanked by a plain scan.
 *
 * `keepStrings` is for a probe whose SUBJECT is a literal: an event name, a
 * menu id, a settings key. It keeps the literals and blanks only the comments.
 */
export function tsCode(sf, source, { keepStrings = false } = {}) {
  let text = source;
  if (!keepStrings) {
    const chars = source.split("");
    const visit = (node) => {
      if (TS_LITERAL_KINDS.some((is) => is(node))) {
        for (let i = node.getStart(sf); i < node.end; i++) if (chars[i] !== "\n") chars[i] = " ";
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    text = chars.join("");
  }
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** `it.each` → ["it", "each"]; anything not rooted in an identifier → null. */
function calleeChain(expr) {
  const parts = [];
  let e = expr;
  while (ts.isPropertyAccessExpression(e)) {
    parts.unshift(e.name.text);
    e = e.expression;
  }
  return ts.isIdentifier(e) ? [e.text, ...parts] : null;
}

const CASE_ROOTS = new Set(["it", "test"]);
const SUITE_ROOTS = new Set(["describe", "suite"]);
const INERT = new Set(["skip", "todo"]);
const isTitle = (arg) =>
  arg !== undefined && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg));
const titleText = (arg, sf) => (ts.isStringLiteralLike(arg) ? arg.text : arg.getText(sf));

/**
 * An argument that could BE the handler. A title with nothing after it is
 * vitest's todo form — `it("placeholder")` registers a case that never runs —
 * and `test("x", undefined)` is the same placeholder spelled out, so neither
 * is the deliverable a DoD checker is asserting. Anything that
 * can evaluate to a function counts, including `it(title, options, fn)`.
 */
const isHandlerArg = (arg) =>
  arg !== undefined &&
  !ts.isStringLiteralLike(arg) &&
  !ts.isNumericLiteral(arg) &&
  !ts.isObjectLiteralExpression(arg) &&
  !ts.isArrayLiteralExpression(arg) &&
  !(ts.isIdentifier(arg) && arg.text === "undefined") &&
  arg.kind !== ts.SyntaxKind.NullKeyword &&
  arg.kind !== ts.SyntaxKind.TrueKeyword &&
  arg.kind !== ts.SyntaxKind.FalseKeyword;

/**
 * Roots a file DECLARES for itself, so its `it(...)` is not vitest's.
 * `import { it } from "vitest"` is the ordinary form and does not shadow; a
 * local `const it = () => {}` does, and it is exactly how a placeholder would
 * satisfy a "declares a case" probe.
 */
function shadowedRoots(sf) {
  const shadowed = new Set();
  const consider = (name) => {
    if (ts.isIdentifier(name) && (CASE_ROOTS.has(name.text) || SUITE_ROOTS.has(name.text))) shadowed.add(name.text);
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) consider(st.name);
    else if (ts.isClassDeclaration(st) && st.name) consider(st.name);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) consider(d.name);
  }
  return shadowed;
}

/**
 * Cases the file DECLARES: `it("…", fn)` / `test("…", fn)` calls whose first
 * argument is a title (so `it.each([...])` — whose first argument is the table
 * — counts once, through the call it returns) and which carry a handler, minus
 * `.skip`/`.todo` cases and every case under a `describe.skip`/`.todo` suite.
 * Comments, strings and template literals are not code and cannot declare one.
 *
 * With `titleIncludes`, only cases whose title CONTAINS that text count — what
 * a DoD assertion means by "this named test exists", where a grep for the
 * title also matched an `it.skip` and a title in a comment.
 */
export function declaredTestCases(sf, { titleIncludes } = {}) {
  const shadowed = shadowedRoots(sf);
  let count = 0;
  const visit = (node, inert) => {
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      if (ts.isCallExpression(callee)) callee = callee.expression;
      const chain = calleeChain(callee);
      if (chain && !shadowed.has(chain[0])) {
        const skipped = inert || chain.slice(1).some((p) => INERT.has(p));
        const title = node.arguments[0];
        if (
          CASE_ROOTS.has(chain[0]) &&
          !skipped &&
          isTitle(title) &&
          node.arguments.slice(1).some(isHandlerArg) &&
          (titleIncludes === undefined || titleText(title, sf).includes(titleIncludes))
        ) {
          count += 1;
        }
        if (SUITE_ROOTS.has(chain[0])) {
          ts.forEachChild(node, (child) => visit(child, skipped));
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inert));
  };
  visit(sf, false);
  return count;
}
