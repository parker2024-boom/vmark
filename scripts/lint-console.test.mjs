// WI-RA13A.4 — the bare-console gate exempts by FILE, never by what a line happens to contain
/**
 * Runs the REAL `scripts/lint-console.sh` with a fixture tree as its working
 * directory (the script scans `src/` relative to where it is run).
 *
 * The exemptions are a list of files — the debug loggers, the perf tool, the
 * test setup, the PDF template — plus doc-comment lines. They used to be
 * applied with `grep -v` over the whole `path:line:content` record, so each
 * exemption also matched CONTENT: a call whose arguments mentioned
 * `utils/debug/`, or contained ` * `, or `.test.`, was waved through from any
 * file. Every case in the "content cannot exempt" block passed the old gate.
 *
 * @coordinates-with scripts/lint-console.sh — the gate under test
 * @module scripts/lint-console.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "lint-console.sh");

const CLEAN = 'import { log } from "@/utils/debug";\nexport const f = () => log("x");\n';

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "lint-console-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function run(root) {
  const r = spawnSync("bash", [SCRIPT], { cwd: root, encoding: "utf8" });
  return { ...r, out: r.stdout + r.stderr };
}

/** A tree with one clean file plus the given extra files. */
const withFiles = (files) => fixture({ "src/clean.ts": CLEAN, ...files });

describe("lint-console.sh — what it flags", () => {
  it("exits 0 on a tree with no console calls and says how many files it scanned", () => {
    const r = run(withFiles({ "src/a/b.tsx": CLEAN }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("OK: No bare console.* calls found in production code (2 files scanned).");
  });

  // WI-RA13B.7 — every console method writes to the user's devtools; the gate
  // used to see only error, warn and log.
  it.each(["error", "warn", "log", "info", "debug", "trace", "table", "dir", "group"])(
    "a bare console.%s fails and is reported with file and line",
    (method) => {
      const r = run(withFiles({ "src/feature/thing.ts": `export const f = () => {\n  console.${method}("x");\n};\n` }));
      expect(r.status).toBe(1);
      expect(r.out).toContain("Found bare console.* calls in production code");
      expect(r.out).toContain(`src/feature/thing.ts:2:  console.${method}("x");`);
    },
  );

  it("a name that merely ends in console is not a call on the console", () => {
    const r = run(withFiles({ "src/x.ts": "const myconsole = { info: () => 1 };\nexport const v = myconsole.info();\n" }));
    expect(r.status, r.out).toBe(0);
  });

  it("finds a call in a .tsx file and in a deeply nested directory", () => {
    const r = run(withFiles({ "src/a/b/c/d/View.tsx": "export const V = () => { console.log(1); return null; };\n" }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/a/b/c/d/View.tsx:1:");
  });

  it("reports every offending line, not just the first", () => {
    const r = run(withFiles({ "src/x.ts": "console.log(1);\nconst a = 1;\nconsole.warn(a);\n", "src/y.ts": "console.error(2);\n" }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/x.ts:1:");
    expect(r.out).toContain("src/x.ts:3:");
    expect(r.out).toContain("src/y.ts:1:");
  });

  it("a commented-out call is still flagged — that is commented-out code", () => {
    const r = run(withFiles({ "src/x.ts": "// console.log(debugValue);\n" }));
    expect(r.status).toBe(1);
  });

  it("handles CRLF sources and non-ASCII content", () => {
    const r = run(withFiles({ "src/x.ts": 'const 标题 = "标题";\r\nconsole.log(标题);\r\n' }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/x.ts:2:");
  });

  it("files that are not .ts/.tsx are not scanned", () => {
    const r = run(withFiles({ "src/x.js": "console.log(1);\n", "src/notes.md": "console.log(1)\n" }));
    expect(r.status, r.out).toBe(0);
  });
});

describe("lint-console.sh — the exemptions, by file", () => {
  const CALL = 'console.error("x");\n';

  it.each([
    "src/utils/debug.ts",
    "src/utils/debug/error.ts",
    "src/utils/debug/nested/deep.ts",
    "src/utils/perfLog.ts",
    "src/test/setup.ts",
    "src/export/pdfHtmlTemplate.ts",
    "src/feature/thing.test.ts",
    "src/feature/thing.webkit.test.tsx",
    "src/feature/__tests__/helper.ts",
  ])("%s may call console", (rel) => {
    const r = run(withFiles({ [rel]: CALL }));
    expect(r.status, r.out).toBe(0);
  });

  it("a doc-comment line that shows a console call is not a call", () => {
    const doc = "/**\n * @example\n *   onProgress: (s) => console.log(s),\n   * console.warn(indented);\n */\nexport const f = 1;\n";
    const r = run(withFiles({ "src/x.ts": doc }));
    expect(r.status, r.out).toBe(0);
  });

  // Near-misses of each exempt NAME. The old patterns were unanchored
  // substrings, so each of these was exempt too.
  it.each([
    "src/feature/setup.ts",
    "src/test/setup.tsx",
    "src/feature/mysetup.ts",
    "src/feature/perfLog.ts",
    "src/utils/perfLogger.ts",
    "src/feature/pdfHtmlTemplate.ts",
    "src/feature/utils/debug.ts",
    "src/feature/utils/debug/x.ts",
    "src/utils/debug.tsx",
    "src/utils/debugger.ts",
    "src/feature/latest.ts",
    "src/feature/contest.tsx",
  ])("%s is NOT exempt", (rel) => {
    const r = run(withFiles({ [rel]: CALL }));
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${rel}:1:`);
  });
});

describe("lint-console.sh — content cannot exempt a line", () => {
  it.each([
    ["a multiplication", "console.log(a * b);"],
    ["a string naming the debug directory", 'console.log("see utils/debug/ for loggers");'],
    ["a string naming debug.ts", 'console.warn("moved to utils/debug.ts");'],
    ["a string naming a test file", 'console.error("failed in thing.test.ts");'],
    ["a string naming __tests__", 'console.log("__tests__ dir");'],
    ["a string naming setup.ts", 'console.log("loaded setup.ts");'],
    ["a string naming perfLog.ts", 'console.log("perfLog.ts");'],
    ["a string naming pdfHtmlTemplate.ts", 'console.log("pdfHtmlTemplate.ts");'],
    ["a string naming node_modules", 'console.log("node_modules/x");'],
    ["a trailing block comment", "console.log(1); /* note * here */"],
  ])("%s does not hide the call", (_label, line) => {
    const r = run(withFiles({ "src/feature/thing.ts": `const a = 1, b = 2;\n${line}\n` }));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("src/feature/thing.ts:2:");
  });
});

describe("lint-console.sh — a tree it did not scan never passes", () => {
  it("fails when there is no src/ directory", () => {
    const r = run(fixture({ "lib/x.ts": CLEAN }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("src/ not found");
    expect(r.out).not.toContain("OK:");
  });

  it("fails when src/ holds no TypeScript file at all", () => {
    const r = run(fixture({ "src/readme.md": "x\n" }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("scanned 0 files");
    expect(r.out).not.toContain("OK:");
  });
});
