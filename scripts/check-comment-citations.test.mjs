// WI-RA17G.9 / WI-RA17G.10 — no calendar date and no dev-docs/ document path in a production comment, or the gate fails.
// WI-RA28.2 — the Claude Code hooks under .claude/hooks/ are read by the same date and dev-docs rules.
/**
 * Drives the date and dev-docs rules of `scripts/lib/commentCitations.mjs`,
 * the shell comment reader they use, and the provenance CLI that reports them.
 * Each rule is pinned in both directions: the citation that must fail, and the
 * nearest identifier that must not (a date inside a tracked path, the date of
 * a tracked audit record, a dev-docs path the file's own code uses).
 *
 * @coordinates-with scripts/lib/commentCitations.mjs — the rules under test
 * @coordinates-with scripts/lib/sourceComments.mjs — the shell comment reader
 * @coordinates-with scripts/check-provenance-ids.mjs — the CLI that reports these findings
 * @module scripts/check-comment-citations.test
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { datesIn, devDocsPathsIn, scanCitations } from "./lib/commentCitations.mjs";
import { scanTree } from "./lib/provenanceIds.mjs";
import { commentRuns, comments } from "./lib/sourceComments.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-provenance-ids.mjs");
const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fixture tree from `{ "rel/path": content }`. */
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "comment-citations-"));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const dates = (text, records) => datesIn(text, new Set(records)).map((d) => d.token);
const AUDIT_RECORD = { ".cc-suite/audits/audit-fix-20260907-144403-findings.md": "# findings\n" };

describe("datesIn: what counts as a calendar date", () => {
  it("finds every form this tree has used", () => {
    expect(dates("// Measured 2026-08-16: ignored.")).toEqual(["2026-08-16"]);
    expect(dates("// seen 20260729, again 2026/07/30")).toEqual(["20260729", "2026/07/30"]);
    expect(dates("// split in 2026-02, restored March 3, 2026 and 4 May 2026")).toEqual(["2026-02", "March 3, 2026", "4 May 2026"]);
    expect(dates("// Restored after the May 2026 pruning.")).toEqual(["May 2026"]);
  });

  it("does not take a number shaped like a date for one", () => {
    expect(dates("// month 13 and day 32: 20261301 2026-13-01 20260732")).toEqual([]);
    expect(dates("// run 32701401717, inode 208183964, build 1202608150")).toEqual([]);
    expect(dates("// in 2026 the year alone is not a date; nor is v2026.1")).toEqual([]);
    expect(dates("// may 2026 users — lowercase is the verb")).toEqual([]);
  });

  it("lets a date inside a path or a file name stand — it is an identifier", () => {
    expect(dates("// see .claude/adr/plans/20260504-mcp-pruning.md §2")).toEqual([]);
    expect(dates("// recorded in `audit-fix-20260805-findings.md`.")).toEqual([]);
    expect(dates("// see 20260504-mcp-pruning")).toEqual(["20260504"]);
  });

  it("lets the date of a TRACKED audit record stand inside its citation, wrapped or not", () => {
    expect(dates("// (audit 20260907 #84)", ["20260907"])).toEqual([]);
    expect(dates("/* the split (audit\n * 20260907, #277): which fraction */", ["20260907"])).toEqual([]);
    expect(dates("// (audit 20260907 #84)", [])).toEqual(["20260907"]);
    expect(dates("// (audit 20260907 #84), measured 2026-09-08", ["20260907"])).toEqual(["2026-09-08"]);
  });
});

describe("devDocsPathsIn: what counts as a dev-docs citation", () => {
  const paths = (text, code) => devDocsPathsIn(text, code).map((p) => p.token);

  it("refuses a path to a document or to a folder below the top level", () => {
    expect(paths("// see dev-docs/plans/20260819-browser-wire.md.")).toEqual(["dev-docs/plans/20260819-browser-wire.md"]);
    expect(paths("// (see dev-docs/grills/terminal/)")).toEqual(["dev-docs/grills/terminal"]);
    expect(paths("// `../dev-docs/e2e-testing.md`")).toEqual(["dev-docs/e2e-testing.md"]);
  });

  it("allows the directory and its top-level convention folders — layout, not a document", () => {
    expect(paths("// dev-docs/ is gitignored; plans go to dev-docs/plans/ and dev-docs/plans/*.md")).toEqual([]);
    expect(paths("// a `website/dev-docs-archive/x.md` sibling is not dev-docs")).toEqual([]);
  });

  it("allows a path the file's own code uses, and only that path", () => {
    const code = 'writeFileSync("dev-docs/architecture-graph.md", doc);';
    expect(paths("// Generates dev-docs/architecture-graph.md", code)).toEqual([]);
    expect(paths("// Generates dev-docs/architecture-metrics.md", code)).toEqual(["dev-docs/architecture-metrics.md"]);
  });
});

describe("comments: shell scripts", () => {
  const texts = (src) => comments(src, "x.sh").map((c) => c.text);

  it("reads whole-line # comments, not the shebang and not a trailing comment", () => {
    expect(texts("#!/usr/bin/env bash\n# one\n  # two\necho hi # trailing\n")).toEqual(["# one", "# two"]);
  });

  it("skips heredoc bodies, quoted or not, and `<<-` with a tab-indented terminator", () => {
    const src = "cat <<'EOF'\n# not a comment\n# nor this\nEOF\n# after\ncat <<-END\n\t# inside\n\t# still inside\n\tEND\n# last\n";
    expect(texts(src)).toEqual(["# after", "# last"]);
  });

  it("does not take a here-string for a heredoc", () => {
    expect(texts('read -r x <<< "$y"\n# still read\n')).toEqual(["# still read"]);
  });

  it("returns spans that slice back to the comment, CRLF included", () => {
    const src = "echo a\r\n# crlf comment\r\n";
    const [c] = comments(src, "x.sh");
    expect(src.slice(c.start, c.end)).toBe("# crlf comment");
  });
});

describe("commentRuns: a citation that wraps across line comments is read whole", () => {
  it("merges comments on consecutive lines, and only those", () => {
    const src = "a(); // one\n  // two\n\n// three\n/* four */\n";
    expect(commentRuns(src, "x.ts").map((r) => r.text)).toEqual(["// one\n  // two", "// three\n/* four */"]);
  });

  it("lets a tracked audit date wrapped onto the next `//` or `///` line stand, and refuses an untracked one", () => {
    const root = tree({
      ...AUDIT_RECORD,
      "src/a.ts": "// split out (audit\n// 20260907 #84) for reuse\nexport {};\n",
      "src-tauri/src/b.rs": "/// deleted the fallback (audit\n/// 20260906, B1) with the data loss\nfn f() {}\n",
    });
    expect(scanCitations(root).map((c) => `${c.file}:${c.line} ${c.token}`)).toEqual(["src-tauri/src/b.rs:2 20260906"]);
  });

  it("makes the provenance rules see an undated audit id that wraps across `//` lines", () => {
    const root = tree({ "src-tauri/src/c.rs": "// a model returning 2.0 must not earn a verdict (audit\n// C3). Treat it as no signal.\nfn f() {}\n" });
    expect(scanTree(root).map((t) => [t.token, t.reason])).toEqual([["audit C3", "an audit citation with no date names no record"]]);
  });
});

describe("scanCitations", () => {
  it("reads production comments under the provenance trees and scripts/, never tests, journeys or literals", () => {
    const root = tree({
      ...AUDIT_RECORD,
      "src/a.ts": 'const s = "2026-08-16";\n// measured 2026-08-16\n// audit 20260907 #84\n',
      "src/a.test.ts": "// 2026-08-16\n",
      "src/b.css": "/* maintainer, 2026-09-02 */\n",
      "src-tauri/src/c.rs": "//! See dev-docs/specs/format-v0.md\n",
      "scripts/d.mjs": "// Plan: dev-docs/plans/x.md\n",
      "scripts/e.sh": "#!/bin/bash\n# since 2026-08-09\necho 2026-08-09\n",
      "scripts/__tests__/f.mjs": "// 2026-08-16\n",
      "e2e/journeys/g.mjs": "// 2026-08-16\n",
      "website/h.ts": "// 2026-08-16\n",
    });
    expect(scanCitations(root).map((c) => `${c.kind} ${c.file}:${c.line} ${c.token}`)).toEqual([
      "date src/a.ts:2 2026-08-16",
      "date src/b.css:1 2026-09-02",
      "dev-docs src-tauri/src/c.rs:1 dev-docs/specs/format-v0.md",
      "dev-docs scripts/d.mjs:1 dev-docs/plans/x.md",
      "date scripts/e.sh:2 2026-08-09",
    ]);
  });

  it("reads the Claude Code hooks too — they run on every edit, and their comments explain why", () => {
    const root = tree({
      ".claude/hooks/guard.mjs": "// relocated by the 2026-07 refactors\n// Scope (per dev-docs/plans/x.md)\nexport {};\n",
      ".claude/hooks/run.sh": "#!/bin/bash\n# since 2026-08-03\n",
      ".claude/hooks/guard.test.mjs": "// 2026-08-16\n",
      ".claude/settings.json": '{ "//": "2026-08-16" }\n',
    });
    expect(scanCitations(root).map((c) => `${c.kind} ${c.file}:${c.line} ${c.token}`)).toEqual([
      "date .claude/hooks/guard.mjs:1 2026-07",
      "dev-docs .claude/hooks/guard.mjs:2 dev-docs/plans/x.md",
      "date .claude/hooks/run.sh:2 2026-08-03",
    ]);
  });
});

describe("CLI (check-provenance-ids)", () => {
  const run = (root) => spawnSync(process.execPath, [SCRIPT, `--root=${root}`], { encoding: "utf8" });

  it("exits 0 on a tree whose comments carry neither", () => {
    const res = run(tree({ ...AUDIT_RECORD, "src/a.ts": "// audit 20260907 #84\n// see .claude/adr/plans/20260504-x.md\nexport {};\n" }));
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no production comment carries a calendar date or a dev-docs\/ document path/);
  });

  it("exits 1 and lists each date and dev-docs path with its location", () => {
    const res = run(tree({ "src/a.ts": "export {};\n// measured 2026-08-16\n", "scripts/b.mjs": "// dev-docs/plans/x.md\n" }));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/2 calendar date\(s\) or dev-docs\/ path\(s\)/);
    expect(res.stderr).toMatch(/src\/a\.ts:2 {2}2026-08-16\n.*calendar date/);
    expect(res.stderr).toMatch(/scripts\/b\.mjs:1 {2}dev-docs\/plans\/x\.md\n.*no clone can read/);
  });
});
