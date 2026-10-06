/**
 * Purpose: read ONE test file's use of the clock off its syntax tree, for
 *   `check-test-timer-isolation.mjs`.
 *
 * Three questions, each answered on the AST rather than by matching text, so a
 * `Date.now()` in a comment or a `setTimeout` in a string is not an answer:
 *
 *   - does the file CONTROL the clock? (`useFakeTimers()`, `setSystemTime()`,
 *     or `spyOn(Date, …)`)
 *   - where does it READ the wall clock? (`Date.now()`, `new Date()` with no
 *     argument — `new Date(0)` names an instant and is deterministic)
 *   - where does it SLEEP on the wall clock? (`new Promise(r => setTimeout(r,
 *     N))` with a literal N, directly or through a helper — defined in the
 *     file or imported from a shared test utility — called with a literal)
 *
 * Key decisions:
 *   - A sleep helper is recognized when it is declared in the file being read,
 *     or imported by name from a module the caller can resolve (a shared test
 *     utility). Resolving the import is the caller's job — this module reads
 *     one file and asks `importedSleepHelper(spec, name)` for each named
 *     import; `scripts/lib/timerIsolationImports.mjs` answers it.
 *   - A duration that is not a numeric literal is not reported. The gate
 *     reports what it can prove, and a threshold needs a number.
 *
 * @coordinates-with scripts/check-test-timer-isolation.mjs — the gate that applies the rules
 * @coordinates-with scripts/lib/timerIsolationImports.mjs — resolves imported sleep helpers
 * @module scripts/check-test-timer-isolation.scan
 */
import ts from "typescript";

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** `vi.useFakeTimers` -> "useFakeTimers"; `useFakeTimers` -> "useFakeTimers". */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

const isDateIdentifier = (node) => node !== undefined && ts.isIdentifier(node) && node.text === "Date";

/** The numeric value of a literal duration (`200`, `1_000`), else null. */
function literalMs(node) {
  if (node === undefined || !ts.isNumericLiteral(node)) return null;
  const value = Number(node.text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Whether the test itself waits on `node` here — `await node`, through any
 * parentheses — rather than handing the promise on (a mock's delayed result,
 * a value a helper returns), which fake timers advance like any other timer.
 */
function isAwaited(node) {
  let child = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return !!parent && ts.isAwaitExpression(parent) && parent.expression === child;
}

/** `setTimeout(...)` / `window.setTimeout(...)` / `globalThis.setTimeout(...)`. */
function isSetTimeoutCall(node) {
  return ts.isCallExpression(node) && calleeName(node.expression) === "setTimeout";
}

/**
 * If `node` is `new Promise(<fn>)` whose executor resolves through
 * `setTimeout(<its first parameter>, <delay>)`, return that delay expression.
 *
 * The resolver must be the executor's own first parameter: a timeout-GUARD
 * (`new Promise((_, reject) => setTimeout(reject, n))`) is not a sleep, and
 * neither is a promise that schedules unrelated work.
 */
function sleepDelayOf(node) {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "Promise") {
    return undefined;
  }
  const executor = node.arguments?.[0];
  if (!executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return undefined;
  const resolver = executor.parameters[0]?.name;
  if (!resolver || !ts.isIdentifier(resolver)) return undefined;

  let delay;
  const visit = (child) => {
    if (delay !== undefined) return;
    if (isSetTimeoutCall(child)) {
      const [callback, ms] = child.arguments;
      const resolvesDirectly = callback && ts.isIdentifier(callback) && callback.text === resolver.text;
      // `setTimeout(() => resolve(), n)` and `setTimeout(() => resolve(value), n)`.
      const resolvesInArrow =
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.getText().includes(`${resolver.text}(`);
      if ((resolvesDirectly || resolvesInArrow) && ms !== undefined) {
        delay = ms;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(executor.body);
  return delay;
}

/**
 * Names of sleep helpers declared in this file, mapped to the index of the
 * parameter that carries the duration: `const sleep = (ms) => new Promise(r =>
 * setTimeout(r, ms))` -> `{ sleep: 0 }`.
 */
function sleepHelpers(sf) {
  const helpers = new Map();
  const consider = (name, fn) => {
    if (!name || !fn?.parameters) return;
    let found;
    const visit = (child) => {
      if (found !== undefined) return;
      const delay = sleepDelayOf(child);
      if (delay !== undefined && ts.isIdentifier(delay)) {
        const index = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === delay.text);
        if (index !== -1) found = index;
        return;
      }
      ts.forEachChild(child, visit);
    };
    if (fn.body) visit(fn.body);
    if (found !== undefined) helpers.set(name, found);
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) consider(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      consider(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return helpers;
}

/** Parse `source`, throwing on a syntax error rather than reading a partial tree. */
function parse(source, fileName) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const parseErrors = sf.parseDiagnostics ?? [];
  if (parseErrors.length > 0) {
    throw new Error(ts.flattenDiagnosticMessageText(parseErrors[0].messageText, " "));
  }
  return sf;
}

/**
 * What a module offers an importer: the sleep helpers it declares (name ->
 * duration parameter index) and its re-exports, `{ exported, imported, spec }`
 * (`imported` is `"*"` for `export * from`).
 */
export function sleepExportsOf(source, fileName = "module.ts") {
  const sf = parse(source, fileName);
  const reexports = [];
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!stmt.exportClause) reexports.push({ exported: "*", imported: "*", spec });
    else if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        reexports.push({ exported: el.name.text, imported: (el.propertyName ?? el.name).text, spec });
      }
    }
  }
  return { helpers: sleepHelpers(sf), reexports };
}

/** Named imports whose source module declares (or re-exports) a sleep helper. */
function importedHelpers(sf, importedSleepHelper) {
  const helpers = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const index = importedSleepHelper(stmt.moduleSpecifier.text, (el.propertyName ?? el.name).text);
      if (index !== undefined) helpers.set(el.name.text, index);
    }
  }
  return helpers;
}

/**
 * Read one test file.
 *
 * @param {string} source
 * @param {string} [fileName] decides TS vs TSX parsing
 * @param {{ importedSleepHelper?: (spec: string, name: string) => number | undefined }} [options]
 *   answers whether a named import is a sleep helper, and which parameter is
 *   its duration; without it only helpers declared in the file count
 * @returns {{
 *   controlsClock: boolean,
 *   fakesTimers: boolean,
 *   wallClockReads: { line: number, what: string }[],
 *   sleeps: { line: number, ms: number, awaited: boolean }[],
 * }}
 *   `awaited` is true when the test awaits the sleep where it is written.
 *   `controlsClock` is any control of the clock (fake timers, a mocked Date);
 *   `fakesTimers` is `useFakeTimers()` alone — a mocked Date leaves the timers
 *   real, so it does not stop a sleep from waiting on the wall clock.
 * @throws when the file does not parse — the caller reports that rather than
 *   treating an unreadable file as a clean one.
 */
export function scanTestClockUsage(source, fileName = "file.test.ts", { importedSleepHelper } = {}) {
  const sf = parse(source, fileName);
  // A helper declared in the file shadows an imported one of the same name.
  const helpers = new Map([
    ...(importedSleepHelper ? importedHelpers(sf, importedSleepHelper) : []),
    ...sleepHelpers(sf),
  ]);
  let controlsClock = false;
  let fakesTimers = false;
  const wallClockReads = [];
  const sleeps = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "useFakeTimers") fakesTimers = true;
      if (name === "useFakeTimers" || name === "setSystemTime") controlsClock = true;
      if (name === "spyOn" && isDateIdentifier(node.arguments[0])) controlsClock = true;

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        isDateIdentifier(node.expression.expression) &&
        node.expression.name.text === "now"
      ) {
        wallClockReads.push({ line: lineOf(sf, node), what: "Date.now()" });
      }

      if (ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
        const ms = literalMs(node.arguments[helpers.get(node.expression.text)]);
        if (ms !== null) sleeps.push({ line: lineOf(sf, node), ms, awaited: isAwaited(node) });
      }
    }

    if (ts.isNewExpression(node)) {
      if (isDateIdentifier(node.expression) && (node.arguments?.length ?? 0) === 0) {
        wallClockReads.push({ line: lineOf(sf, node), what: "new Date()" });
      }
      const ms = literalMs(sleepDelayOf(node));
      if (ms !== null) sleeps.push({ line: lineOf(sf, node), ms, awaited: isAwaited(node) });
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { controlsClock, fakesTimers, wallClockReads, sleeps };
}
