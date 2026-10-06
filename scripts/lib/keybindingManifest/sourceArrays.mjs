/**
 * The array literals the keybinding gate reads: `DEFAULT_SHORTCUTS` in the
 * TypeScript definitions and the `DEFAULT_ACCELERATORS` /
 * `PLATFORM_ACCELERATORS` contract mirror in Rust.
 *
 * Purpose: locate each array by its DECLARATION (through the TypeScript parser,
 * or over blanked Rust code), narrow it to its balanced closing bracket, and
 * read its elements — failing closed on any element shape it did not read, so
 * no entry can drop out of the comparison unnoticed.
 *
 * @coordinates-with scripts/check-keybinding-manifest.mjs — the CLI that runs the legs
 * @coordinates-with scripts/lib/arrayLiteralEnd.mjs — the balanced-bracket scanner
 * @module scripts/lib/keybindingManifest/sourceArrays
 */
import ts from "typescript";
import { arrayLiteralEnd } from "../arrayLiteralEnd.mjs";
import { rustCode } from "../rustSource.mjs";
import { RUST_PATH, fail } from "./context.mjs";

/**
 * Every DEPTH-1 string field of one object literal, in SOURCE ORDER (a
 * duplicate key keeps the LAST assignment, which is the value JavaScript
 * builds). Read from the parser, not from a regex over the literal's text: a
 * `// id: "x"` inside the entry, and an `id` inside a NESTED object, both
 * satisfied the old boundary-anchored search and stood in for the real
 * property.
 *
 * A SPREAD or a COMPUTED key fails the gate rather than being skipped: either
 * can override a literal that is right there in the source, so the value this
 * function would report is not the value the app uses.
 */
function objectStringFields(obj, rel, name) {
  const fields = new Map();
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p) || (p.name !== undefined && ts.isComputedPropertyName(p.name))) {
      fail(
        `${rel}: ${name} contains an entry with a ${ts.isSpreadAssignment(p) ? "spread" : "computed key"}. ` +
          "Either can override a literal property, so the accelerator this gate would check " +
          "is not necessarily the one the app binds — it fails closed instead.",
      );
    }
    if (!ts.isPropertyAssignment(p)) continue;
    if (!ts.isIdentifier(p.name) && !ts.isStringLiteralLike(p.name)) continue;
    fields.set(p.name.text, ts.isStringLiteralLike(p.initializer) ? p.initializer.text : undefined);
  }
  return fields;
}

/**
 * Parse an array of `{ ... }` object literals from a TS source region.
 * `region` must already be narrowed to the array body (`arrayBody`).
 *
 * PARSED, not brace-counted. The hand-rolled splitter collected the balanced
 * `{ … }` groups it found and IGNORED every other array element, so a
 * `...MORE_SHORTCUTS`, a bare identifier or a `makeEntry("x")` contributed
 * definitions the drift check never saw — and the entry-count guard compared
 * two numbers that both excluded them, so it could not notice.
 * Every element must now be an object literal, or the gate fails closed.
 */
export function parseObjectLiterals(region, rel, name) {
  const sf = ts.createSourceFile(`${name}.ts`, `(${region}])`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics.length > 0) {
    fail(`${rel}: ${name} does not parse: ${ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0].messageText, " ")}`);
  }
  let arr;
  const findArray = (node) => {
    if (arr) return;
    if (ts.isArrayLiteralExpression(node)) arr = node;
    else ts.forEachChild(node, findArray);
  };
  findArray(sf);
  if (!arr) fail(`${rel}: ${name} — no array literal to read`);
  const out = [];
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) {
      fail(
        `${rel}: ${name} holds an array element that is not an object literal: ` +
          `${el.getText(sf).replace(/\s+/g, " ").slice(0, 160)}\n  The gate fails closed: ` +
          "a spread, an identifier or a factory call hides every shortcut it contributes.",
      );
    }
    const fields = objectStringFields(el, rel, name);
    const id = fields.get("id");
    if (id === undefined) {
      const menuId = fields.get("menuId");
      const hint = menuId
        ? ` — this entry has menuId "${menuId}" but no extractable string \`id\``
        : " — no extractable string \`id\`";
      fail(
        `${rel}: ${name} contains an object literal the drift gate cannot parse${hint}. ` +
          `Fragment: ${el.getText(sf).replace(/\s+/g, " ").trim().slice(0, 160)}\n  The gate fails closed: give the entry a plain ` +
          "\`id: \"…\"\` property so its accelerator can be verified.",
      );
    }
    out.push({
      id,
      label: fields.get("label"),
      defaultKey: fields.get("defaultKey"),
      defaultKeyMac: fields.get("defaultKeyMac"),
      defaultKeyOther: fields.get("defaultKeyOther"),
      menuId: fields.get("menuId"),
    });
  }
  // Belt-and-suspenders: one parsed entry per array element (unreachable after
  // the per-element fail() above, but makes the invariant explicit).
  if (out.length !== arr.elements.length) {
    fail(
      `${rel}: ${name} parsed ${out.length} entries from ${arr.elements.length} array ` +
        "elements — the gate fails closed on any dropped entry",
    );
  }
  return out;
}

/**
 * The `[` that opens `ident`'s array declaration in TypeScript, from the
 * PARSER — not from a regex over raw text.
 *
 * A declaration-shaped comment or string anchored the regex: `// const
 * DEFAULT_SHORTCUTS: Shortcut[] = [` in a header, or the same text inside a
 * template literal, matched before the real declaration and handed the parse an
 * array that is not the one the app builds. The parser has no
 * such ambiguity, and it already has to succeed here — `arrayLiteralEnd` refuses
 * a source with parse diagnostics — so this costs one extra parse and no new
 * failure mode. `as const` / `satisfies` / parentheses are unwrapped, since each
 * wraps the array without changing which array it is.
 */
function tsDeclarationOpen(src, ident, rel) {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics.length > 0) {
    fail(`${rel}: does not parse: ${ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0].messageText, " ")}`);
  }
  let open = -1;
  const unwrap = (node) => {
    let n = node;
    while (
      n !== undefined &&
      (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n))
    ) {
      n = n.expression;
    }
    return n;
  };
  const visit = (node) => {
    if (open !== -1) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ident) {
      const init = unwrap(node.initializer);
      if (init !== undefined && ts.isArrayLiteralExpression(init)) {
        open = init.getStart(sf);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return open;
}

/**
 * The `[` that opens `ident`'s array declaration in Rust
 * (`const NAME: &[(&str, &str)] = &[`).
 *
 * Matched over fully-blanked CODE — `rustCode` blanks comments AND literals
 * while preserving offsets — for the same reason as the TypeScript side: this
 * gate's Rust input already arrives with `keepStrings: true`, so a
 * declaration-shaped string would still have anchored it.
 */
function rustDeclarationOpen(src, ident) {
  const decl = new RegExp(`(?:const|let|var|static)\\s+${ident}\\b[^=\\n]*=\\s*&?\\s*\\[`);
  const m = decl.exec(rustCode(src));
  return m ? m.index + m[0].length - 1 : -1;
}

/** Narrow source to the body of `const NAME ... = [ ... ];`. */
export function arrayBody(src, name, rel) {
  // Anchor on the DECLARATION, not the first mention of the name. `indexOf`
  // matched the name inside the file's header comment and then took whatever
  // `[` came next — which stayed correct only while no other array happened to
  // be declared in between. Adding one (the category table) silently made this
  // parse the wrong array and report zero definitions.
  // Callers used to pass "const NAME" to dodge the comment-mention problem;
  // the declaration anchor makes the identifier alone sufficient either way.
  // The END is the BALANCED closing bracket (strings and comments skipped —
  // scripts/lib/arrayLiteralEnd.mjs), not the first textual `];`: a comment
  // mentioning `];` inside the array used to truncate the parse and drop every
  // later entry from the check with nothing to fail on.
  const ident = name.trim().split(/\s+/).pop();
  const open = rel.endsWith(".rs") ? rustDeclarationOpen(src, ident) : tsDeclarationOpen(src, ident, rel);
  if (open === -1) fail(`${rel}: could not find a declaration of ${ident}`);
  // The scanner is language-specific: TS regex literals and nested templates,
  // Rust nested block comments and raw strings each need their own tokenizer,
  // and one hand-rolled loop was wrong for both.
  const close = arrayLiteralEnd(src, open, { lang: rel.endsWith(".rs") ? "rust" : "ts" });
  if (close === -1) fail(`${rel}: no balanced array closing after ${name}`);
  return src.slice(open, close);
}

/**
 * Every element of a contract array must be read by `re`. Matching and moving
 * on lets a tuple shape this parser does not understand vanish silently — and
 * an id missing from the mirror is only caught when a manifest entry names it,
 * so a mirror-only entry disappeared with nothing to fail on.
 */
export function readTuples(body, re, name) {
  const matches = [...body.matchAll(re)];
  const marks = body.split("");
  for (const m of matches) for (let i = m.index; i < m.index + m[0].length; i++) marks[i] = " ";
  const residue = marks.join("").replace(/[\s,[\]]+/g, "");
  if (residue !== "") {
    fail(
      `${RUST_PATH}: ${name} holds array element text this gate did not read: ` +
        `${JSON.stringify(residue.slice(0, 120))} — the gate fails closed rather than ` +
        "checking the tuples it happened to understand.",
    );
  }
  return matches;
}
