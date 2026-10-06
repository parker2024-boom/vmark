/**
 * Dialog literals: hardcoded English passed to a dialog or toast, and raw
 * ask()/confirm() calls outside the confirmAction funnel.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @coordinates-with src/services/dialogs/confirmAction.ts — the funnel this enforces
 * @module scripts/i18n-keys/dialogLiterals
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { ROOT } from "./paths.js";

// ─── Dialog-literal check ────────────────────────────────────────────────────
//
// A string LITERAL passed to ask()/confirm()/message()/confirmAction()/toast.*
// is hardcoded English the locale files cannot reach. The check walks a real
// TS AST (the house rule since check-command-error-ratchet: no hand-rolled
// lexing), and ALSO refuses raw `ask(`/`window.confirm(` call sites outside
// services/dialogs/confirmAction.ts — the funnel that keeps every destructive
// confirmation on one dialog shape. (dependency-cruiser cannot see NAMED
// imports, so the funnel is enforced here where the AST already is.)

const TOAST_MODULES = /^(sonner|@\/services\/ime\/imeToast|.*\/imeToast)$/;

/** Per-file dialog/toast literal scan — pure over (path, source), exported for
 *  behavioral tests (a walker cannot be pointed at a fixture tree). */
export function dialogLiteralFindings(rel: string, text: string): string[] {
  const DIALOG_FNS = new Set(["ask", "confirm", "message", "confirmAction"]);
  const problems: string[] = [];
  if (
    !/\b(ask|confirm|message|confirmAction|toast)\s*[(.]/.test(text) &&
    !/from ["'][^"']*(sonner|imeToast)["']/.test(text)
  ) return problems;
  {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const isFunnel = rel.endsWith("services/dialogs/confirmAction.ts");
    const line = (node: import("typescript").Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    // Toast identity is resolved from IMPORT BINDINGS, not identifier
    // spelling: `import { toast as notify }` must still be seen, and a local
    // helper that happens to be named `toast` must not be. Inside the toast
    // module itself the wrapper object is the export, so the name is trusted.
    const toastNames = new Set<string>();
    if (/imeToast\.ts$/.test(rel)) toastNames.add("toast");
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (!TOAST_MODULES.test(stmt.moduleSpecifier.text)) continue;
      const clause = stmt.importClause;
      if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      for (const el of clause.namedBindings.elements) {
        const exported = (el.propertyName ?? el.name).text;
        if (exported === "toast" || exported === "imeToast") toastNames.add(el.name.text);
      }
    }

    const visit = (node: import("typescript").Node) => {
      if (ts.isCallExpression(node)) {
        let fnName: string | null = null;
        let isToast = false;
        if (ts.isIdentifier(node.expression)) {
          fnName = node.expression.text;
          // sonner's primary API is the BARE call — toast("Saved") — not just
          // toast.success(...); without this the most common form slips past.
          if (toastNames.has(fnName)) isToast = true;
        }
        else if (ts.isPropertyAccessExpression(node.expression)) {
          const obj = node.expression.expression;
          if (ts.isIdentifier(obj) && obj.text === "window") fnName = node.expression.name.text;
          if (ts.isIdentifier(obj) && toastNames.has(obj.text)) { isToast = true; fnName = obj.text; }
        }
        // The funnel: raw ask()/window.confirm() live only in confirmAction.ts.
        if (!isFunnel && (fnName === "ask" || (fnName === "confirm" && ts.isPropertyAccessExpression(node.expression)))) {
          problems.push(`${rel}:${line(node)}  raw ${fnName}() — route it through services/dialogs/confirmAction.ts`);
        }
        if (!isFunnel && fnName === "confirm" && ts.isIdentifier(node.expression)) {
          // bare confirm() — the browser global; a store method named confirm
          // is a MEMBER access and does not land here.
          problems.push(`${rel}:${line(node)}  raw confirm() — route it through services/dialogs/confirmAction.ts`);
        }
        // Hardcoded English: a first-argument string literal (or a template/
        // binary concat containing one) to a dialog/toast surface.
        const flagLiteral = (arg: import("typescript").Expression | undefined, label: string) => {
          if (!arg) return;
          const carriesLiteral = (e: import("typescript").Expression): boolean => {
            if (ts.isStringLiteralLike(e)) return /[A-Za-z]{2}/.test(e.text);
            if (ts.isTemplateExpression(e)) return /[A-Za-z]{2}\s+[A-Za-z]{2}/.test(e.head.text + e.templateSpans.map((sp) => sp.literal.text).join(""));
            if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return carriesLiteral(e.left) || carriesLiteral(e.right);
            return false;
          };
          if (carriesLiteral(arg)) {
            problems.push(`${rel}:${line(arg)}  hardcoded string passed to ${label} — key it through i18n`);
          }
        };
        if ((fnName && DIALOG_FNS.has(fnName)) || isToast) {
          if (fnName === "confirmAction" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
            for (const prop of node.arguments[0].properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && ["title", "message", "actionLabel"].includes(prop.name.text)) {
                flagLiteral(prop.initializer, `confirmAction ${prop.name.text}`);
              }
            }
          } else if (fnName === "ask" || fnName === "message" || isToast) {
            flagLiteral(node.arguments[0], `${fnName}()`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return problems;
}

export function checkDialogLiterals(): boolean {
  const walkDirs = ["src"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(rel);
      }
    }
  };
  for (const d of walkDirs) walk(d);

  const problems: string[] = [];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    problems.push(...dialogLiteralFindings(rel, text));
  }

  if (problems.length) {
    console.error(`[FAIL]  ${problems.length} hardcoded/raw dialog call(s):`);
    for (const p of problems.slice(0, 30)) console.error(`        ${p}`);
    return false;
  }
  console.log("[OK]    dialog surfaces: no hardcoded literals, ask()/confirm() funneled through confirmAction.");
  return true;
}
