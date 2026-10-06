// @vitest-environment node
// WI-RA9B.9 — the exported reader is plain JavaScript that ships verbatim, so
// nothing forces it through the TypeScript build. These tests ARE its gate: the
// file is type-checked under the project's own compiler options and linted
// under the project's ESLint config, and each check is first shown to be able
// to fail, so "no findings" cannot mean "nothing looked".
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { ESLint } from "eslint";

const ROOT = process.cwd();
const READER = resolve(ROOT, "src/export/reader/vmark-reader.js");
const source = readFileSync(READER, "utf8");

/** The app's compiler options, with JavaScript checking switched on. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = resolve(ROOT, "tsconfig.json");
  const { config, error } = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  return { ...parsed.options, allowJs: true, checkJs: true, noEmit: true, incremental: false };
}

/** Type-check the reader — or `text` standing in for it — and return readable diagnostics. */
function typeCheck(text: string = source): string[] {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const readFromDisk = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    resolve(fileName) === READER
      ? ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.JS)
      : readFromDisk(fileName, languageVersion, ...rest);
  const program = ts.createProgram([READER], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return `TS${d.code}: ${message}`;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName.replace(`${ROOT}/`, "")}:${line + 1} TS${d.code}: ${message}`;
  });
}

describe("the exported reader is type-checked", () => {
  it("opts in to checking with the ts-check pragma on its first line", () => {
    expect(source.split("\n")[0]).toBe("// @ts-check");
  });

  it("runs under the project's strict options", () => {
    const options = compilerOptions();
    expect(options.strict).toBe(true);
    expect(options.checkJs).toBe(true);
  });

  it("the check can fail: a type error planted in the reader is reported", () => {
    const planted = source.replace(
      "'use strict';",
      "'use strict';\n  /** @type {number} */ const planted = 'not a number'; void planted;",
    );
    expect(planted).not.toBe(source);
    const found = typeCheck(planted);
    expect(found.some((line) => line.includes("TS2322"))).toBe(true);
  });

  it("has no type errors", () => {
    expect(typeCheck()).toEqual([]);
  });
});

describe("the exported reader is linted", () => {
  const eslint = new ESLint({ cwd: ROOT });

  it("is covered by rules, not merely matched by the config", async () => {
    const config = (await eslint.calculateConfigForFile(READER)) as {
      rules?: Record<string, unknown[]>;
      languageOptions?: { sourceType?: string };
    };
    for (const rule of ["no-undef", "no-unused-vars", "eqeqeq", "no-restricted-syntax"]) {
      expect(config.rules?.[rule]?.[0], rule).toBe(2);
    }
    // A classic script: `import` must be a syntax error, because the file is inlined into a <script>.
    expect(config.languageOptions?.sourceType).toBe("script");
  });

  it("the check can fail: defects planted at the reader's path are reported", async () => {
    const planted = [
      "(function() {",
      "  'use strict';",
      "  var unused = 1;",
      "  if (missingGlobal == 2) window.scrollTo({ top: 0, behavior: 'smooth' });",
      "})();",
    ].join("\n");
    const [result] = await eslint.lintText(planted, { filePath: READER });
    const rules = new Set(result?.messages.map((m) => m.ruleId));
    expect([...rules].sort()).toEqual(["eqeqeq", "no-restricted-syntax", "no-undef", "no-unused-vars"]);
  });

  it("has no lint findings", async () => {
    const [result] = await eslint.lintFiles([READER]);
    expect(result?.messages.map((m) => `${m.line}: ${m.ruleId} ${m.message}`)).toEqual([]);
  });
});
