/**
 * Purpose: the `journey-shape` probe behind `scripts/dod-syntax.mjs` — does a
 *   journey file statically satisfy e2e/run-journeys.mjs's discovery contract
 *   (`export default { name, run }`, `name` a non-empty string literal, `run` a
 *   function)? Fails closed on any shape it cannot resolve without executing
 *   the module.
 *
 * @coordinates-with scripts/dod-syntax.mjs — the CLI this answers for
 * @coordinates-with e2e/run-journeys.mjs — the discovery contract mirrored here
 * @module scripts/lib/dodSyntaxJourney
 */
import ts from "typescript";

/**
 * The initializer (or function declaration) a top-level `name` binds to, if
 * any. Variable bindings must be `const`: a `let` can be reassigned after the
 * literal the checker inspected, so its initializer is not what the runner
 * will import.
 */
function topLevelBinding(sf, name) {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
    if (!ts.isVariableStatement(st)) continue;
    if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer;
    }
  }
  return undefined;
}

/** Is there an `<name>.<anything> = …` assignment anywhere in the file? */
function isMutated(sf, name) {
  let mutated = false;
  const visit = (node) => {
    if (mutated) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === name
    ) {
      mutated = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return mutated;
}

const isFunctionLike = (node) =>
  node !== undefined &&
  (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node));

/**
 * The property that DECIDES `name` at runtime: the LAST assignment in source
 * order, because that is the one the object literal keeps. Taking the first
 * meant `{ name: "journey", name: "" }` — and any spread or computed key that
 * overrides it — read as valid while the runner saw something else. A
 * spread or a computed key is not resolvable statically at all, so it is
 * reported rather than skipped.
 */
function propertyNamed(obj, name) {
  let found;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return { unresolvable: "a spread that may override it" };
    if (p.name !== undefined && ts.isComputedPropertyName(p.name)) return { unresolvable: "a computed key that may override it" };
    if (p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) found = p;
  }
  return found;
}

/**
 * The shape e2e/run-journeys.mjs discovers: `export default { name, run }`
 * with a non-empty string `name` and a function `run` — on the literal itself,
 * or on a top-level const the default export names. Anything it cannot
 * resolve statically is reported as not discoverable, with the reason.
 */
export function journeyShape(sf) {
  if (sf.parseDiagnostics.length > 0) {
    return { ok: false, reason: `does not parse: ${ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0].messageText, " ")}` };
  }
  const exported = sf.statements.find((s) => ts.isExportAssignment(s) && !s.isExportEquals);
  if (!exported) return { ok: false, reason: "no `export default`" };
  let obj = exported.expression;
  if (ts.isIdentifier(obj)) obj = topLevelBinding(sf, obj.text);
  if (!obj || !ts.isObjectLiteralExpression(obj)) {
    return { ok: false, reason: "`export default` is not an object literal (nor a top-level const holding one)" };
  }
  if (ts.isIdentifier(exported.expression) && isMutated(sf, exported.expression.text)) {
    return { ok: false, reason: `\`${exported.expression.text}\` is mutated after it is declared, so its literal is not what the runner imports` };
  }
  const nameProp = propertyNamed(obj, "name");
  if (nameProp?.unresolvable) return { ok: false, reason: `\`name\` cannot be resolved statically: the object carries ${nameProp.unresolvable}` };
  const nameValue = nameProp && ts.isPropertyAssignment(nameProp) ? nameProp.initializer : undefined;
  if (!nameValue || !ts.isStringLiteralLike(nameValue) || nameValue.text === "") {
    return { ok: false, reason: "`name` is not a non-empty string literal" };
  }
  const runProp = propertyNamed(obj, "run");
  if (runProp?.unresolvable) return { ok: false, reason: `\`run\` cannot be resolved statically: the object carries ${runProp.unresolvable}` };
  let runIsFunction = false;
  if (runProp && ts.isMethodDeclaration(runProp)) runIsFunction = true;
  else if (runProp && ts.isPropertyAssignment(runProp)) {
    const v = runProp.initializer;
    runIsFunction = isFunctionLike(v) || (ts.isIdentifier(v) && isFunctionLike(topLevelBinding(sf, v.text)));
  } else if (runProp && ts.isShorthandPropertyAssignment(runProp)) {
    runIsFunction = isFunctionLike(topLevelBinding(sf, runProp.name.text));
  }
  if (!runIsFunction) return { ok: false, reason: "`run` is missing or is not a function" };
  return { ok: true, name: nameValue.text };
}
