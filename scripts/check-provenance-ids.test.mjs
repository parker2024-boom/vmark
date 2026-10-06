// WI-RA17E.5 — provenance ids in production comments resolve, or the gate fails.
// WI-RA28.4 — the tooling (scripts/ and .claude/hooks/, shell included) is held to the same rule.
/**
 * Drives the comment reader and the resolution rules against fixture trees in a
 * temp dir, and the real CLI as a subprocess for its exit-code contract. Each
 * rule is pinned in both directions — a token that resolves and the same shape
 * that does not — because a resolver that accepts too much reads as "comments
 * are fine" and one that accepts too little cannot land with zero findings.
 *
 * @coordinates-with scripts/check-provenance-ids.mjs — the CLI under test
 * @coordinates-with scripts/lib/provenanceIds.mjs — the grammar and resolution rules
 * @coordinates-with scripts/lib/sourceComments.mjs — the comment reader
 * @module scripts/check-provenance-ids.test
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs } from "./check-provenance-ids.mjs";
import { isTestPath, productionFiles, scanTree, tokensIn } from "./lib/provenanceIds.mjs";
import { comments } from "./lib/sourceComments.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-provenance-ids.mjs");
const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fixture tree from `{ "rel/path": content }`. */
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "provenance-ids-"));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const PLANS = {
  ".claude/tdd-guardian/plan-a.md": "# A\n- **WI-AB1.2 — first**\n- **WI-2.1 — bare in A**\n- **WI-DUP.1 — twice**\n",
  ".claude/tdd-guardian/plan-b.md": "# B\n- **WI-2.1 — bare in B**\n- **WI-DUP.1 — again**\n",
  ".cc-suite/audits/audit-fix-20260907-144403-findings.md": "# findings\n",
};
const commentTexts = (src, file) => comments(src, file).map((c) => c.text);
const verdicts = (root) => scanTree(root).map((t) => [t.token, t.reason === null]);

describe("comments: literals are never comments", () => {
  it("TypeScript: strings, templates, regexes and JSX text are skipped; trailing comments are read", () => {
    const src = [
      'const a = "// WI-1 in a string";',
      "const b = `/* WI-2 in a template ${a} */`;",
      "const c = /\\/\\/ WI-3/;",
      "const d = <p>// WI-4 jsx text</p>;",
      "f(); // WI-5 trailing",
      "/* WI-6 block */",
    ].join("\n");
    const texts = commentTexts(src, "x.tsx");
    expect(texts).toEqual(["// WI-5 trailing", "/* WI-6 block */"]);
  });

  it("Rust: a raw string holding `//` is code, nested block comments are one comment", () => {
    const src = 'let s = r#"// WI-1"#;\n/* outer /* WI-2 */ still outer */\nlet t = 1; // WI-3\n';
    expect(commentTexts(src, "x.rs")).toEqual(["/* outer /* WI-2 */ still outer */", "// WI-3"]);
  });

  it("CSS: a quoted `/*` is not a comment", () => {
    const src = 'a::before { content: "/* WI-1 */"; }\n/* WI-2 */\n';
    expect(commentTexts(src, "x.css")).toEqual(["/* WI-2 */"]);
  });
});

describe("tokensIn: the grammar", () => {
  const kinds = (text) => tokensIn(text).map((t) => [t.kind, t.token, t.date ?? null]);

  it("reads work-item ids without the sentence's full stop", () => {
    expect(kinds("Fixed in WI-RA27.1. See WI-4.4, WI-SOC.1b and WI-2.")).toEqual([
      ["wi", "WI-RA27.1", null],
      ["wi", "WI-4.4", null],
      ["wi", "WI-SOC.1b", null],
      ["wi", "WI-2", null],
    ]);
  });

  it("reads dated, undated and issue-shaped audit citations", () => {
    expect(kinds("(audit 20260907 #84)")).toEqual([["audit", "audit 20260907 #84", "20260907"]]);
    expect(kinds("(audit 2026-09-03 round 4, #37)")).toEqual([["audit", "audit 2026-09-03 round 4, #37", "20260903"]]);
    expect(kinds("(audit R2 #179)")).toEqual([["audit", "audit R2 #179", null]]);
    expect(kinds("(audit-fix H3)")).toEqual([["audit", "audit-fix H3", null]]);
    expect(kinds("(audit #491/#493)")).toEqual([["issue", "audit #491/#493", null]]);
  });

  it("reads citations that wrap onto the next comment line or hide behind a keyword", () => {
    expect(kinds("a data-loss defect (audit\n * 20260906, B1) because")).toEqual([["audit", "audit 20260906, B1", "20260906"]]);
    expect(kinds("(audit\n/// 20260612)")).toEqual([["audit", "audit 20260612", "20260612"]]);
    expect(kinds("(audit-followups 20260729)")).toEqual([["audit", "audit-followups 20260729", "20260729"]]);
    expect(kinds("(Audit verification round 2, finding 11.)")).toEqual([["audit", "Audit verification round 2, finding 11", null]]);
    expect(kinds("(audit rounds 1 and 2, finding 10)")).toEqual([["audit", "audit rounds 1 and 2, finding 10", null]]);
    expect(kinds("(Audit verification, #4.)")).toEqual([["audit", "Audit verification, #4", null]]);
  });

  it("ignores prose that only mentions an audit", () => {
    expect(kinds("the audit log keeps every row; an audit trail")).toEqual([]);
    expect(kinds("(Audit, High.)")).toEqual([]);
  });
});

describe("resolution", () => {
  it("a namespaced id defined by exactly one tracked plan resolves; by two, it does not", () => {
    const root = tree({ ...PLANS, "src/a.ts": "// WI-AB1.2 x\n// WI-DUP.1 y\nexport {};\n" });
    expect(verdicts(root)).toEqual([
      ["WI-AB1.2", true],
      ["WI-DUP.1", false],
    ]);
  });

  it("a bare id resolves only when its plan is named in the same file", () => {
    const named = tree({ ...PLANS, "src/a.ts": "/** Plan: .claude/tdd-guardian/plan-b.md */\n// WI-2.1 x\nexport {};\n" });
    expect(verdicts(named)).toEqual([["WI-2.1", true]]);
    const unnamed = tree({ ...PLANS, "src/a.ts": "// WI-2.1 x\nexport {};\n" });
    expect(scanTree(unnamed)[0].reason).toMatch(/bare work-item id/);
  });

  it("a plan in dev-docs/ never makes an id resolve", () => {
    const root = tree({ "dev-docs/plans/p.md": "- WI-ZZ1.1\n", "src/a.ts": "// WI-ZZ1.1 (dev-docs/plans/p.md)\nexport {};\n" });
    expect(scanTree(root)[0].reason).toMatch(/no tracked plan/);
  });

  it("an audit citation resolves only with the date of a tracked audit record", () => {
    const root = tree({ ...PLANS, "src-tauri/src/a.rs": "// (audit 20260907 #84)\n// (audit 20260612)\n// (audit R2 #179)\nfn a() {}\n" });
    expect(verdicts(root)).toEqual([
      ["audit 20260907 #84", true],
      ["audit 20260612", false],
      ["audit R2 #179", false],
    ]);
  });

  it("an issue-shaped audit citation is reported but never a finding", () => {
    const root = tree({ "src/a.ts": "// (audit #480)\nexport {};\n" });
    expect(scanTree(root)).toMatchObject([{ kind: "issue", reason: null }]);
  });
});

describe("scope", () => {
  it("test files, journeys and fixtures are not production", () => {
    for (const p of ["src/a.test.ts", "src/x/__tests__/b.ts", "src/test/setup.ts", "e2e/journeys/01.mjs", "src-tauri/src/a/tests.rs", "src-tauri/src/m/migration_v3_tests.rs", "src/b.webkit.test.ts"]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["src/a.ts", "src-tauri/src/tests_util.rs", "e2e/lib/rail.mjs", "src/styles/a.css"]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });

  it("walks every production tree and skips node_modules", () => {
    const root = tree({
      "src/a.ts": "",
      "src/a.test.ts": "",
      "server/mcp/src/b.ts": "",
      "server/mcp/node_modules/c/index.js": "",
      "e2e/lib/d.mjs": "",
      "scripts/e.mjs": "",
    });
    expect(productionFiles(root)).toEqual(["src/a.ts", "server/mcp/src/b.ts", "e2e/lib/d.mjs"]);
  });

  it("holds the tooling to the same rule: scripts/ and .claude/hooks/, shell scripts included", () => {
    const root = tree({
      ...PLANS,
      "scripts/gate.mjs": "// fails closed (audit R2 #83)\nexport {};\n",
      "scripts/lib/phase.sh": "#!/usr/bin/env bash\n# WI-NOPE9.1 linked here\n",
      "scripts/ok.mjs": "// WI-AB1.2 resolves\nexport {};\n",
      ".claude/hooks/guard.mjs": "// moved by WI-10\nexport {};\n",
      "scripts/gate.test.mjs": "// WI-NOPE9.2 belongs in a test header\n",
      "scripts/fixtures/x.mjs": "// audit R9 #1\n",
    });
    expect(scanTree(root).map((t) => `${t.file}:${t.line} ${t.token} ${t.reason === null ? "resolves" : "dangling"}`)).toEqual([
      "scripts/gate.mjs:1 audit R2 #83 dangling",
      "scripts/lib/phase.sh:2 WI-NOPE9.1 dangling",
      "scripts/ok.mjs:1 WI-AB1.2 resolves",
      ".claude/hooks/guard.mjs:1 WI-10 dangling",
    ]);
  });
});

describe("CLI", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("exits 0 when every token resolves", () => {
    const res = run(`--root=${tree({ ...PLANS, "src/a.ts": "// WI-AB1.2\nexport {};\n" })}`);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/1 WI\/audit token\(s\) in 1 production file\(s\), all resolve/);
  });

  it("exits 1 and names the file, line and reason of each finding", () => {
    const res = run(`--root=${tree({ ...PLANS, "src/a.ts": "export {};\n// WI-4.4 why\n" })}`);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/src\/a\.ts:2 {2}WI-4\.4\n.*no tracked plan defines it/);
  });

  it("exits 64 on a bad invocation", () => {
    expect(run("--nope").status).toBe(64);
    expect(run("--root=").status).toBe(64);
    expect(() => parseArgs(["--root", path.join(REPO, "no-such-dir")], REPO)).toThrow(/not a directory/);
  });
});
