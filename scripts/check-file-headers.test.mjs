// WI-RA17G.8 — every production .ts/.tsx under src/ opens with its header and a correct @module, or the gate fails.
/**
 * Drives the header grammar against fixture trees in a temp dir, and the real
 * CLI as a subprocess for its exit-code contract. Each rule is pinned in both
 * directions — a header that passes and the nearest shape that must not —
 * because a grammar that accepts too much reads as "headers are fine" and one
 * that accepts too little cannot land with zero findings.
 *
 * @coordinates-with scripts/check-file-headers.mjs — the CLI under test
 * @coordinates-with scripts/lib/fileHeaders.mjs — the grammar
 * @module scripts/check-file-headers.test
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs } from "./check-file-headers.mjs";
import { MIN_PROSE_WORDS, headerProblems, isHeaderSubject, scanHeaders } from "./lib/fileHeaders.mjs";
import { fsAt } from "./lib/headerReferenceTrees.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-file-headers.mjs");
const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fixture tree from `{ "rel/path": content }`. */
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "file-headers-"));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const header = (mod, prose = "Formats a byte count for the status bar.") => `/**\n * ${prose}\n *\n * @module ${mod}\n */\n`;
const BODY = "\nexport const x = 1;\n";

/** The problems one file has, judged in a tree that holds just that file. */
function problemsOf(rel, source) {
  const root = tree({ [rel]: source });
  return headerProblems(rel, source, fsAt(root));
}

describe("headerProblems: the grammar", () => {
  it("accepts a leading /** block with prose, a correct @module and a blank line after it", () => {
    expect(problemsOf("src/utils/bytes.ts", header("utils/bytes") + BODY)).toEqual([]);
  });

  it("accepts a file that is only its header, and CRLF line endings", () => {
    expect(problemsOf("src/utils/bytes.ts", header("utils/bytes"))).toEqual([]);
    const crlf = (header("utils/bytes") + BODY).replace(/\n/g, "\r\n");
    expect(problemsOf("src/utils/bytes.ts", crlf)).toEqual([]);
  });

  it("rejects a file that opens with code, a `//` run, or a plain `/*` block", () => {
    expect(problemsOf("src/a.ts", "export const x = 1;\n")).toEqual(["the file does not open with a `/** … */` header"]);
    expect(problemsOf("src/a.ts", "// Formats a byte count for the status bar.\n// @module a\n" + BODY)).toEqual([
      "the file does not open with a `/** … */` header",
    ]);
    expect(problemsOf("src/a.ts", "/*\n * Formats a byte count for the status bar.\n * @module a\n */\n" + BODY)).toEqual([
      "the file opens with a block comment that is not a `/**` header",
    ]);
  });

  it("rejects a header that is not the first bytes of the file", () => {
    expect(problemsOf("src/a.ts", "\n" + header("a") + BODY)).toEqual(["the file does not open with a `/** … */` header"]);
  });

  it("rejects a block attached to the first declaration, and accepts the same block once detached", () => {
    const attached = header("utils/cn").replace(/\n$/, "") + "\nexport function cn() {}\n";
    expect(problemsOf("src/utils/cn.ts", attached)).toEqual([
      "the header documents the first declaration — end the `*/` line, then leave a blank line (an import may follow directly)",
    ]);
    const sameLine = header("utils/cn").replace(/\n$/, "") + "import x from 'y';\n";
    expect(problemsOf("src/utils/cn.ts", sameLine)[0]).toMatch(/documents the first declaration/);
    expect(problemsOf("src/utils/cn.ts", header("utils/cn") + "\nexport function cn() {}\n")).toEqual([]);
  });

  it("accepts an import or a re-export directly under the header — statements no doc comment documents", () => {
    for (const next of ['import { a } from "./a";', 'export { a } from "./a";', 'export * from "./a";', 'export type { A } from "./a";']) {
      expect(problemsOf("src/utils/cn.ts", header("utils/cn") + next + "\n"), next).toEqual([]);
    }
    for (const next of ["export const a = 1;", "export type A = string;", "/** The next declaration. */"]) {
      expect(problemsOf("src/utils/cn.ts", header("utils/cn") + next + "\n")[0], next).toMatch(/documents the first declaration/);
    }
  });

  it(`needs ${MIN_PROSE_WORDS} words of prose outside the tag lines — a title or tags alone fail`, () => {
    const four = "/**\n * Byte count status formatter\n * @module utils/bytes\n * @coordinates-with a.ts — the caller of this module\n */\n" + BODY;
    expect(problemsOf("src/utils/bytes.ts", four)).toEqual([
      `the header has 4 word(s) of prose; say what the file is for in at least ${MIN_PROSE_WORDS}`,
    ]);
    const five = four.replace("Byte count status formatter", "Formats byte counts for status");
    expect(problemsOf("src/utils/bytes.ts", five)).toEqual([]);
    expect(problemsOf("src/utils/bytes.ts", "/**\n * Bytes.\n *\n * @module utils/bytes\n */\n" + BODY)[0]).toMatch(/1 word\(s\) of prose/);
  });

  it("requires the @module line, and requires it to name this file", () => {
    expect(problemsOf("src/utils/bytes.ts", "/**\n * Formats a byte count for the status bar.\n */\n" + BODY)).toEqual([
      "the header has no `@module` line",
    ]);
    expect(problemsOf("src/utils/bytes.ts", header("utils/byte") + BODY)).toEqual([
      "`@module utils/byte` does not name this file; expected `@module utils/bytes`",
    ]);
    expect(problemsOf("src/utils/bytes.ts", header("src/utils/bytes") + BODY)[0]).toMatch(/does not name this file/);
  });

  it("lets an index file name its directory or itself", () => {
    expect(problemsOf("src/plugins/latex/index.ts", header("plugins/latex") + BODY)).toEqual([]);
    expect(problemsOf("src/plugins/latex/index.ts", header("plugins/latex/index") + BODY)).toEqual([]);
    expect(problemsOf("src/plugins/latex/index.ts", header("plugins") + BODY)[0]).toMatch(/does not name this file/);
  });

  it("refuses a second @module anywhere in the file's comments, but not one quoted in a literal", () => {
    const stacked = header("utils/bytes") + "\n/**\n * @module utils/bytes\n */\n" + BODY;
    expect(problemsOf("src/utils/bytes.ts", stacked)).toEqual(["the file carries 2 `@module` lines; keep exactly one, in the header"]);
    const quoted = header("utils/bytes") + "\nexport const doc = `\n * @module utils/bytes\n`;\n";
    expect(problemsOf("src/utils/bytes.ts", quoted)).toEqual([]);
  });

  it("reports a @module that sits outside the header as missing from the header", () => {
    const outside = "/**\n * Formats a byte count for the status bar.\n */\n\n// @module utils/bytes\n" + BODY;
    expect(problemsOf("src/utils/bytes.ts", outside)).toEqual(["the header has no `@module` line"]);
  });
});

describe("isHeaderSubject: the file-size gate's production set under src/", () => {
  it("includes production .ts and .tsx under src/", () => {
    for (const p of ["src/a.ts", "src/components/A.tsx", "src/test/setup.ts", "src/x/a.testUtils.ts"]) expect(isHeaderSubject(p, ""), p).toBe(true);
  });

  it("excludes tests, benches, mocks, declarations, generated files, other trees and other languages", () => {
    for (const p of [
      "src/a.test.ts",
      "src/a.webkit.test.ts",
      "src/a.bench.ts",
      "src/x/__tests__/h.ts",
      "src/x/__mocks__/m.ts",
      "src/vite-env.d.ts",
      "scripts/a.ts",
      "server/mcp/src/a.ts",
      "src/a.js",
      "src/a.css",
    ]) {
      expect(isHeaderSubject(p, ""), p).toBe(false);
    }
    const generated = "// GENERATED FILE — DO NOT EDIT.\nexport {};\n";
    expect(isHeaderSubject("src/x/generated/contract.ts", generated)).toBe(false);
    // The marker alone, outside a generated/ directory, does not exempt a file.
    expect(isHeaderSubject("src/x/contract.ts", generated)).toBe(true);
  });
});

describe("scanHeaders", () => {
  it("walks src/, judges subjects only, and lists findings in path order", () => {
    const root = tree({
      "src/b.ts": "export {};\n",
      "src/a.ts": header("a") + BODY,
      "src/a.test.ts": "export {};\n",
      "src/node_modules/z/index.ts": "export {};\n",
      "scripts/c.ts": "export {};\n",
    });
    const { files, findings } = scanHeaders(root);
    expect(files).toBe(2);
    expect(findings).toEqual([{ file: "src/b.ts", problem: "the file does not open with a `/** … */` header" }]);
  });

  it("throws when there is no src/ to scan", () => {
    expect(() => scanHeaders(tree({ "scripts/a.ts": "" }))).toThrow(/no src\/ directory/);
  });
});

describe("CLI", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("exits 0 when every subject conforms", () => {
    const res = run(`--root=${tree({ "src/a.ts": header("a") + BODY })}`);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/1 production file\(s\) under src\/, every one opens with its header/);
  });

  it("exits 1 and names the file and the problem", () => {
    const res = run(`--root=${tree({ "src/a.ts": header("a") + BODY, "src/b.ts": header("a") + BODY })}`);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/1 header problem\(s\) in 1 file\(s\)/);
    expect(res.stderr).toMatch(/src\/b\.ts\n.*`@module a` does not name this file; expected `@module b`/);
  });

  it("exits 1 when the scan finds no subject at all — a mis-aimed scan is not a clean tree", () => {
    const res = run(`--root=${tree({ "src/a.test.ts": "" })}`);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no subject files found/);
  });

  it("exits 64 on a bad invocation", () => {
    expect(run("--nope").status).toBe(64);
    expect(run("--root=").status).toBe(64);
    expect(() => parseArgs(["--root", path.join(REPO, "no-such-dir")], REPO)).toThrow(/not a directory/);
  });
});
