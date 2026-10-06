/**
 * The frontend half of the CommandError ratchet: files that invoke a TYPED
 * command and render its rejection with `String(...)` / `errorMessage(...)`,
 * which prints "[object Object]" for a `CommandError`.
 *
 * Purpose: parse every production frontend source under `src/` with the
 * TypeScript compiler and report, per file, the first stringified rejection of
 * a typed command, honouring `// command-error-ok: <reason>` markers per site.
 *
 * @coordinates-with scripts/check-command-error-ratchet.mjs — the gate CLI that re-exports this
 * @coordinates-with scripts/lib/commandErrorRatchet/rustCommands.mjs — supplies the typed command names
 * @module scripts/lib/commandErrorRatchet/stringifiedErrors
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Files that invoke a TYPED command and render its rejection with `String(...)`
 * or `errorMessage(...)` instead of `commandErrorMessage(...)`.
 *
 * **Parsed, not lexed.** Three rounds of hand-rolled scanning each shipped a
 * fresh false negative — nested, parenthesised, object and function generic
 * arguments; a `}` inside a string closing a catch block early;
 * `.catch(async (e) => …)`; a shadowing inner parameter. The MECHANISM was the
 * defect, so this walks a real TypeScript AST, the way `check-mock-boundaries`,
 * `check-shell-slots` and `check-hooks-react-purity` already do. Scope and
 * string contents then come from the parser instead of from another regex.
 *
 * Deliberately SILENT for files that only invoke LEGACY commands: `String(e)`
 * is CORRECT while the command still returns `Result<T, String>`, and flagging
 * it would demand a change that is wrong until the conversion lands.
 */
export function findStringifiedTypedErrors(files, typedCommands) {
  const hits = [];
  for (const { path: file, source } of files) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));

    // Command names are not always literals: `restartWithHotExit.ts` invokes
    // `HOT_EXIT_COMMANDS.CAPTURE` from a `const … as const` map, and requiring a
    // literal left the gate blind to a LIVE [object Object] defect there. Bind
    // simple compile-time constants — a `const X = "cmd"` and the properties of
    // a `const M = { K: "cmd" }` — which is how every such call in this repo is
    // written. Anything less tractable stays unresolved rather than guessed.
    // ONLY `const` declarations, and only names declared ONCE in the file.
    // Collecting `let`/`var` too meant a reassigned binding resolved to its
    // initializer, and a file-global map meant two same-named consts in
    // different scopes resolved to whichever was visited last — a guessed
    // command name either enables this gate on the wrong file or attributes a
    // finding to a command the file never invokes. An ambiguous
    // name is left UNRESOLVED rather than guessed.
    const constStrings = new Map();
    const ambiguous = new Set();
    const record = (key, value) => {
      if (constStrings.has(key) && constStrings.get(key) !== value) ambiguous.add(key);
      constStrings.set(key, value);
    };
    const collectConsts = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name) &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        const init = node.initializer;
        if (ts.isStringLiteralLike(init)) {
          record(node.name.text, init.text);
        } else if (ts.isAsExpression(init) || ts.isObjectLiteralExpression(init)) {
          const obj = ts.isAsExpression(init) ? init.expression : init;
          if (ts.isObjectLiteralExpression(obj)) {
            for (const prop of obj.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
                ts.isStringLiteralLike(prop.initializer)
              ) {
                record(`${node.name.text}.${prop.name.text}`, prop.initializer.text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, collectConsts);
    };
    collectConsts(sf);
    for (const key of ambiguous) constStrings.delete(key);

    /** The command name an argument denotes, or null when it cannot be resolved. */
    const commandNameOf = (arg) => {
      if (!arg) return null;
      if (ts.isStringLiteralLike(arg)) return arg.text;
      if (ts.isIdentifier(arg)) return constStrings.get(arg.text) ?? null;
      if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)) {
        return constStrings.get(`${arg.expression.text}.${arg.name.text}`) ?? null;
      }
      return null;
    };

    let command = null;
    const findInvoke = (node) => {
      if (command !== null) return;
      if (ts.isCallExpression(node)) {
        // Tauri's `invoke` is imported and called as a BARE identifier
        // (`@tauri-apps/api/core`). Accepting `x.invoke(...)` made any method
        // of that name the IPC entry point — `src/test/statefulFsFake.ts`
        // exposes exactly one — so an unrelated call could arm this gate on a
        // file that invokes no command at all.
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : null;
        if (name === "invoke") {
          const resolved = commandNameOf(node.arguments[0]);
          if (resolved !== null && typedCommands.has(resolved)) command = resolved;
        }
      }
      ts.forEachChild(node, findInvoke);
    };
    findInvoke(sf);
    if (command === null) continue;

    // A `// command-error-ok: <reason>` marker suppresses only the site it
    // precedes, not the whole file. The reason is required — a bare marker is a
    // mute button, the same rule the i18n allowlist and caret-only marker carry.
    const markers = new Set();
    source.split("\n").forEach((line, i) => {
      if (/\/\/[^\S\n]*command-error-ok:[^\S\n]*\S/.test(line)) markers.add(i);
      else if (/^\s*\/\/\s*\S/.test(line) && markers.has(i - 1)) markers.add(i);
    });

    let found = null;
    // Callbacks whose own parameter IS the caught binding — they must not be
    // treated as shadowing themselves.
    const bindingCallbacks = new WeakSet();
    const walkNode = (node, bound) => {
      if (found) return;
      let next = bound;

      if (ts.isCatchClause(node) && node.variableDeclaration) {
        const nameNode = node.variableDeclaration.name;
        if (ts.isIdentifier(nameNode)) next = new Set(bound).add(nameNode.text);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        // A promise binds its rejection in two places, not one: `.catch(cb)`
        // and `.then(onFulfilled, onRejected)`. Only the first was recognised,
        // so a two-argument `.then` stringified a typed CommandError with the
        // gate silent — a false NEGATIVE, the direction that matters here.
        const method = node.expression.name.text;
        const cb =
          method === "catch" ? node.arguments[0] : method === "then" ? node.arguments[1] : undefined;
        if (
          cb &&
          (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
          cb.parameters[0] &&
          ts.isIdentifier(cb.parameters[0].name)
        ) {
          next = new Set(bound).add(cb.parameters[0].name.text);
          bindingCallbacks.add(cb);
        }
      }

      if (
        bound.size > 0 &&
        !bindingCallbacks.has(node) &&
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))
      ) {
        // An inner parameter of the same name SHADOWS the caught binding.
        const shadowed = node.parameters
          .map((param) => param.name)
          .filter((n) => ts.isIdentifier(n) && next.has(n.text));
        if (shadowed.length > 0) {
          next = new Set(next);
          for (const n of shadowed) next.delete(n.text);
        }
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fn = node.expression.text;
        const arg = node.arguments[0];
        if (
          (fn === "String" || fn === "errorMessage") &&
          node.arguments.length === 1 &&
          arg &&
          ts.isIdentifier(arg) &&
          next.has(arg.text)
        ) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
          if (!markers.has(line) && !markers.has(line - 1)) {
            found = { file, command, line: line + 1 };
          }
        }
      }

      ts.forEachChild(node, (child) => walkNode(child, next));
    };
    walkNode(sf, new Set());
    if (found) hits.push(found);
  }
  return hits;
}

/**
 * JSX must be parsed as JSX, or `<Foo/>` is a syntax error and the file is
 * skipped; TypeScript must be parsed as TypeScript, or a type annotation is.
 *
 * Switched on the actual EXTENSION. The substring test this replaced asked
 * whether the path `includes(".ts")`, which is false for `foo.mts` and
 * `foo.cts` — both of which `FRONTEND_SOURCE` scans — so every ESM/CJS
 * TypeScript module in `src/` was handed to the parser as JavaScript, and a
 * stringified typed error inside one was invisible.
 */
function scriptKindFor(file) {
  const ext = /\.([cm]?[jt]sx?)$/.exec(file)?.[1];
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return ts.ScriptKind.TS;
    case "tsx":
    case "mtsx":
    case "ctsx":
      return ts.ScriptKind.TSX;
    case "jsx":
    case "mjsx":
    case "cjsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

/**
 * Every production JS/TS extension, not just `.ts`/`.tsx`:
 * `src/export/reader/vmark-reader.js` is real production source and a defect
 * there was invisible to this gate. `.spec.` is excluded alongside `.test.`.
 */
const FRONTEND_SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const FRONTEND_TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Frontend sources that could receive a command rejection (tests excluded). */
function walkFrontend(dir, rootLen, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "locales") continue;
      walkFrontend(full, rootLen, out);
    } else if (FRONTEND_SOURCE.test(entry.name) && !FRONTEND_TEST.test(entry.name)) {
      out.push(full.slice(rootLen).split(path.sep).join("/"));
    }
  }
  return out;
}

/** The frontend files that stringify one of `typed`'s command rejections. */
export function scanStringifiedTypedErrors(root, typed) {
  if (typed.size === 0) return [];
  const files = walkFrontend(path.join(root, "src"), root.length + 1, []).map((rel) => ({
    path: rel,
    source: readFileSync(path.join(root, rel), "utf8"),
  }));
  return findStringifiedTypedErrors(files, typed);
}
