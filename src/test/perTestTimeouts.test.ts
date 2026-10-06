// @vitest-environment node
/**
 * WI-RA26.7 — no test sets a timeout of its own below its tier's liveness
 * bound.
 *
 * Purpose: a test timeout is a LIVENESS bound ("this hung"), never a
 * performance assertion, and every tier shares one (`LIVENESS_TIMEOUT_MS` in
 * vitest.shared.ts; `gateTierCoverage.test.ts` pins the configs). A per-test
 * number below it brings back exactly what the shared bound removed: a healthy
 * test reported as hung because the machine was busy. Twenty-odd such numbers
 * (15s to 120s, plus named constants of 30s and 60s) had accumulated across
 * the app, gate and server tiers before this gate.
 *
 * Parsed, not grepped: a regex cannot tell `it(name, fn, 5000)` from
 * `setTimeout(fn, 5000)` or a `waitFor` budget. A timeout given as an
 * identifier is resolved through `const` declarations in the same file; one
 * that cannot be resolved fails, so the gate cannot be bypassed by naming the
 * number somewhere else. Larger bounds are allowed (the pathological scaling
 * suite asks for more than the tier gives).
 *
 * @coordinates-with vitest.shared.ts — LIVENESS_TIMEOUT_MS
 * @coordinates-with src/test/gateTierCoverage.test.ts — the tier configs' bounds
 * @module test/perTestTimeouts.test
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import soakConfig from "../../vitest.soak.config";
import { LIVENESS_TIMEOUT_MS } from "../../vitest.shared";
import { APP_GRAPH_IMPORT_WAIT, ASYNC_IMPORT_WAIT, SURFACE_IMPORT_WAIT } from "./waitBudget";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOTS = ["src", "website/.vitepress", "scripts", ".claude/hooks", "server/mcp/__tests__", "server/content/src"];
const TEST_FILE_RE = /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/;
const TEST_FUNCTIONS = new Set(["it", "test", "describe", "suite", "bench"]);
/** A per-test timeout is written `, N)`, `, NAME)` or `timeout:` — files with none are not parsed. */
const MIGHT_HAVE_TIMEOUT = /,\s*[\d_]+\s*\)|,\s*[A-Z][A-Z0-9_.]*\s*\)|timeout\s*:/;

/** The bound a test file's tier gives every test. */
function tierBound(file: string): number {
  if (/\.soak\.test\./.test(file)) return soakConfig.test?.testTimeout ?? LIVENESS_TIMEOUT_MS;
  return LIVENESS_TIMEOUT_MS;
}

function testFiles(): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) found.push(child);
    }
  };
  for (const root of ROOTS) walk(root);
  return found.sort();
}

/** The name a call chain starts from: `it` for `it.each(x)(...)` or `it.skipIf(c)(...)`. */
function rootName(callee: ts.Expression): string | null {
  let node: ts.Expression = callee;
  for (;;) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isCallExpression(node)) node = node.expression;
    else return null;
  }
}

const isFunctionLike = (node: ts.Node): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node);

export interface TimeoutFinding {
  file: string;
  line: number;
  /** The resolved timeout, or null when it could not be resolved statically. */
  value: number | null;
  text: string;
}

/** Every per-test (or per-suite) timeout a test file sets, resolved where possible. */
export function findPerTestTimeouts(file: string, source: string): TimeoutFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const resolve = (expr: ts.Expression, depth = 0): number | null => {
    if (depth > 10) return null;
    if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ""));
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return resolve(expr.expression, depth + 1);
    if (ts.isIdentifier(expr)) {
      const init = consts.get(expr.text);
      if (init) return resolve(init, depth + 1);
      // The shared bound itself, imported from vitest.shared.ts.
      return expr.text === "LIVENESS_TIMEOUT_MS" ? LIVENESS_TIMEOUT_MS : null;
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.name.text === "timeout") {
      const init = consts.get(expr.expression.text);
      const object = init && (ts.isAsExpression(init) ? init.expression : init);
      if (object && ts.isObjectLiteralExpression(object)) return optionTimeout(object, depth + 1);
      return null;
    }
    if (ts.isBinaryExpression(expr)) {
      const left = resolve(expr.left, depth + 1);
      const right = resolve(expr.right, depth + 1);
      if (left === null || right === null) return null;
      if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
      if (expr.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
      if (expr.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    }
    return null;
  };
  const optionTimeout = (object: ts.ObjectLiteralExpression, depth: number): number | null => {
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "timeout") {
        return resolve(property.initializer, depth + 1);
      }
    }
    return null;
  };

  const findings: TimeoutFinding[] = [];
  const report = (expr: ts.Expression, value: number | null) => {
    const { line } = sf.getLineAndCharacterOfPosition(expr.getStart(sf));
    findings.push({ file, line: line + 1, value, text: expr.getText(sf) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = rootName(node.expression);
      const fnIndex = node.arguments.findIndex(isFunctionLike);
      if (name !== null && TEST_FUNCTIONS.has(name) && fnIndex !== -1) {
        node.arguments.forEach((arg, index) => {
          if (index < fnIndex && ts.isObjectLiteralExpression(arg)) {
            const hasTimeout = arg.properties.some(
              (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "timeout",
            );
            if (hasTimeout) report(arg, optionTimeout(arg, 0));
          }
          if (index === fnIndex + 1) {
            if (ts.isObjectLiteralExpression(arg)) {
              if (arg.properties.length > 0) report(arg, optionTimeout(arg, 0));
            } else {
              report(arg, resolve(arg));
            }
          }
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

describe("per-test timeouts", () => {
  it("the finder sees every spelling of a per-test timeout, and nothing else", () => {
    const source = [
      'const LOCAL = 2_000;',
      'const BUDGET = { timeout: 3000 } as const;',
      'it("a", () => {}, 1000);',
      'it("b", { timeout: 1500 }, () => {});',
      'it.each([1])("c", () => {}, LOCAL);',
      'test.skipIf(false)("d", async () => {}, BUDGET.timeout);',
      'describe("e", () => {}, LOCAL + 500);',
      'it("f", () => {}, IMPORTED_SOMEWHERE);',
      'const CEILING = LIVENESS_TIMEOUT_MS;',
      'it("h", () => {}, CEILING + 30_000);',
      'setTimeout(() => {}, 5000);',
      'vi.waitFor(() => {}, { timeout: 100 });',
      'it("g", () => {});',
    ].join("\n");
    expect(findPerTestTimeouts("x.test.ts", source).map((f) => f.value)).toEqual([
      1000, 1500, 2000, 3000, 2500, null, LIVENESS_TIMEOUT_MS + 30_000,
    ]);
  });

  it("every wait budget sits below the bound of the test that encloses it", () => {
    // Otherwise the test is killed first and reports a bare timeout instead of
    // the waitFor message naming what never appeared (src/test/waitBudget.ts).
    for (const budget of [ASYNC_IMPORT_WAIT, SURFACE_IMPORT_WAIT, APP_GRAPH_IMPORT_WAIT]) {
      expect(budget.timeout).toBeLessThan(LIVENESS_TIMEOUT_MS);
    }
  });

  it("no test file sets a timeout below its tier's liveness bound", () => {
    const offenders: string[] = [];
    for (const file of testFiles()) {
      const source = readFileSync(path.join(REPO, file), "utf8");
      if (!MIGHT_HAVE_TIMEOUT.test(source)) continue;
      for (const finding of findPerTestTimeouts(file, source)) {
        if (finding.value === null) {
          offenders.push(`${file}:${finding.line} — "${finding.text}" cannot be resolved to a number here`);
        } else if (finding.value < tierBound(file)) {
          offenders.push(`${file}:${finding.line} — ${finding.value}ms is below the tier's ${tierBound(file)}ms`);
        }
      }
    }
    expect(
      offenders,
      "A test timeout is a liveness bound, and the tier already has one: drop the per-test " +
        "number. A performance claim belongs in a growth exponent or src/test/timeBudget.ts.",
    ).toEqual([]);
  });
});
