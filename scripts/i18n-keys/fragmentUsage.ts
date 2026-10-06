/**
 * Where a registered fragment is rendered alone in JSX instead of appended to
 * its sentence.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @coordinates-with scripts/i18n-keys/fragments.ts — the registrations and key matching
 * @module scripts/i18n-keys/fragmentUsage
 */
import ts from "typescript";

import { INLINE_TAGS, NON_DISPLAY_ATTRIBUTE, fragmentRefs, matchFragment } from "./fragments.js";

/**
 * JSX where a registered fragment is the only content of its block: rendered
 * alone rather than appended to a sentence. Matched on the KEY, whatever the
 * translate function is called (`t`, an alias, `i18n.t`), and on
 * `<Trans i18nKey>`. The walk from the fragment up to the nearest non-inline
 * element looks for company at EVERY level — a sibling inside an inline
 * wrapper, `"Cannot render " + t(fragment)`, a template literal's text — so
 * `Cannot render <a>{t(fragment)}</a>` belongs to its sentence while
 * `<div role="status">{t(fragment)}</div>` — the "(6:1)" strip — does not.
 * `{null}`, `{false}`, `{undefined}` and comments render nothing and are no
 * company; a `<>` fragment is transparent; an attribute value is its own
 * context.
 *
 * Known limitation — reachability needs types. `a || b` / `a ?? b` render `a`
 * when it is truthy / non-nullish and `b` otherwise, and which happens depends
 * on `a`'s type. Syntax cannot know it, so the left side counts only when it
 * DEFINITELY renders, and a fallback that renders counts even when the types
 * make it unreachable (`flag ?? <span>text</span>`, dead code a type-aware
 * `no-unnecessary-condition` would catch). The backstop is exact:
 * `fragmentSiteFindings` pins every use to a registered file.
 */
export function fragmentUsageFindings(
  rel: string,
  text: string,
  fragments: Readonly<Record<string, unknown>>,
): string[] {
  const refs = fragmentRefs(fragments);
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];

  const tagName = (el: ts.JsxElement) => el.openingElement.tagName.getText(sf);
  // What statically renders nothing: null/undefined/booleans (literals,
  // `!x`, comparisons), `<></>`, and `&&`/`||`/`??`/`?:` whose every outcome
  // is one of those.
  const BOOLEAN_OPERATORS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword,
  ]);
  const rendersSomething = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e)) return rendersSomething(e.expression);
    if (ts.isStringLiteralLike(e)) return e.text.trim() !== "";
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(e) && e.text === "undefined") return false;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return false;
    if (ts.isConditionalExpression(e)) return rendersSomething(e.whenTrue) || rendersSomething(e.whenFalse);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (BOOLEAN_OPERATORS.has(op)) return false;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return rendersSomething(e.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        // The left side renders only when it is truthy, and whether an
        // identifier holds text or a flag needs the type checker. Fail
        // closed: it is company only when it DEFINITELY renders.
        return rendersSomething(e.right) || rendersDefinitely(e.left);
      }
    }
    if (ts.isJsxFragment(e) || ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) return meaningful(e);
    return true;
  };
  // An intrinsic element (`<span>`, `<b/>`) is company only if it holds some;
  // a component's output is unknown, so it counts, and a form control shows
  // its value.
  const isIntrinsic = (tag: ts.JsxTagNameExpression) =>
    ts.isIdentifier(tag) && /^[a-z]/.test(tag.text) && !/^(input|textarea|select)$/.test(tag.text);
  /** Renders visible content whatever its runtime value: text, a template, or JSX with content. */
  const rendersDefinitely = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e)) return rendersDefinitely(e.expression);
    if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e) || ts.isJsxFragment(e) || ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) {
      return rendersSomething(e);
    }
    return false;
  };
  const meaningful = (child: ts.JsxChild): boolean => {
    if (ts.isJsxText(child)) return child.text.trim() !== "";
    if (ts.isJsxExpression(child)) return child.expression ? rendersSomething(child.expression) : false;
    if (ts.isJsxFragment(child)) return child.children.some(meaningful);
    if (ts.isJsxSelfClosingElement(child)) return !isIntrinsic(child.tagName);
    if (ts.isJsxElement(child)) return !isIntrinsic(child.openingElement.tagName) || child.children.some(meaningful);
    return true;
  };
  const contains = (outer: ts.Node, inner: ts.Node) => outer.pos <= inner.pos && inner.end <= outer.end;
  /** Whether `parent` gives `child` (the step of the walk inside it) company. */
  const hasCompany = (parent: ts.Node, child: ts.Node): boolean => {
    if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
      return parent.children.some((c) => !contains(c, child) && meaningful(c));
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return rendersSomething(parent.left === child ? parent.right : parent.left);
    }
    if (
      ts.isArrayLiteralExpression(parent) &&
      ts.isPropertyAccessExpression(parent.parent) &&
      parent.parent.name.text === "join" &&
      ts.isCallExpression(parent.parent.parent)
    ) {
      return parent.elements.some((el) => el !== child && rendersSomething(el));
    }
    if (ts.isTemplateExpression(parent)) {
      return (
        parent.head.text.trim() !== "" ||
        parent.templateSpans.some((span) => span.literal.text.trim() !== "" || (!contains(span, child) && rendersSomething(span.expression)))
      );
    }
    return false;
  };
  const aloneInBlock = (node: ts.Node): boolean => {
    // Inside JSX at all? If the walk reaches the component's boundary through
    // only inline wrappers and `<>`, what they hold is what gets rendered.
    let inJsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (hasCompany(parent, child)) return false;
      // An attribute value is its own context: shown if the attribute is
      // (title, aria-label, alt, placeholder), never if it is not.
      if (ts.isJsxAttribute(parent)) return !NON_DISPLAY_ATTRIBUTE.test(parent.name.getText(sf));
      if (ts.isJsxElement(parent)) {
        if (!INLINE_TAGS.has(tagName(parent))) return true;
        inJsx = true;
      } else if (ts.isJsxFragment(parent)) {
        inJsx = true;
      }
      if (ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isFunctionLike(parent)) break;
    }
    return inJsx;
  };

  const visit = (node: ts.Node) => {
    let key: string | null = null;
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) key = matchFragment(first.text, refs)?.key ?? null;
    } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "i18nKey" || !attr.initializer) continue;
        const init = attr.initializer;
        const literal = ts.isJsxExpression(init) ? init.expression : init;
        if (literal && ts.isStringLiteralLike(literal)) key = matchFragment(literal.text, refs)?.key ?? null;
      }
    }
    const subject = ts.isJsxOpeningElement(node) ? node.parent : node;
    if (key && aloneInBlock(subject)) out.push(`${rel}: ${key} rendered alone`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
