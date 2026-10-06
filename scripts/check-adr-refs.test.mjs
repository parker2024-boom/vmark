// WI-RA15A.5 — every decision-record id cited by a tracked file resolves to a record under .claude/adr/.
/**
 * Self-test of the decision-record reference gate.
 *
 * The ids in this file are assembled from `A` so the gate, which reads every
 * tracked file including this one, does not take a fixture for a citation.
 *
 * @coordinates-with scripts/check-adr-refs.mjs — the gate under test
 * @module scripts/check-adr-refs.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCitations, isRepoWideId, definedIds } from "./check-adr-refs.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-adr-refs.mjs");
const A = "ADR" + "-";

const record = (num, title = "A decision") => `# ${A}${num}: ${title}\n\nBody.\n`;
const planFile = (ids) =>
  `# Decisions — a plan\n\n> Defines: ${ids.map((i) => A + i).join(", ")}. Local ids.\n\n` +
  ids.map((i) => `### ${A}${i} — something decided\n\nBody.\n`).join("\n");
const readme = (...links) => `# Records\n\n${links.map((l) => `- [x](${l})`).join("\n")}\n`;

/** A git repository holding `files`; the gate reads what git would publish. */
function repo(files, { untracked = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "adr-refs-"));
  const put = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  const git = (...a) =>
    execFileSync("git", ["-c", "user.email=g@example.test", "-c", "user.name=G", "-c", "commit.gpgsign=false", ...a], {
      cwd: dir,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  for (const [rel, body] of Object.entries(untracked)) put(rel, body);
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, `--root=${dir}`, ...args], { encoding: "utf8" });

/** The smallest tree the gate accepts: one record, one plan file, both indexed. */
const base = (extra = {}) => ({
  ".claude/adr/README.md": readme(`${A}013-service-tier.md`, "plans/20260101-a-plan.md"),
  [`.claude/adr/${A}013-service-tier.md`]: record("013"),
  ".claude/adr/plans/20260101-a-plan.md": planFile(["1", "2"]),
  ...extra,
});

describe("extractCitations — the id grammar", () => {
  const ids = (text) => extractCitations(text).map((c) => c.id);

  it("reads repository-wide and plan-scoped ids, with their line", () => {
    const found = extractCitations(`see ${A}013\nand (${A}2, ${A}PDF1a)\n`);
    expect(found).toEqual([
      { id: `${A}013`, line: 1 },
      { id: `${A}2`, line: 2 },
      { id: `${A}PDF1a`, line: 2 },
    ]);
  });

  it("reads lettered, suffixed and slash-joined ids", () => {
    expect(ids(`${A}BR2 ${A}1a ${A}C4. ${A}2/${A}5 [${A}T1]`)).toEqual(
      ["BR2", "1a", "C4", "2", "5", "T1"].map((i) => A + i),
    );
  });

  it("ignores placeholders and prose that only looks like an id", () => {
    expect(ids(`${A}N ${A}NNN ${A}level ${A}related ${A}style, an ${A}UA-1 note, QUADR-7`)).toEqual([]);
  });

  it("reads an id next to CJK text and at the end of input", () => {
    expect(ids(`多格式计划的${A}4，以及 ${A}7`)).toEqual([`${A}4`, `${A}7`]);
  });

  it("returns nothing for empty input", () => {
    expect(extractCitations("")).toEqual([]);
  });

  it("tells a repository-wide id (three digits) from a plan-scoped one", () => {
    expect(isRepoWideId(`${A}013`)).toBe(true);
    expect(isRepoWideId(`${A}13`)).toBe(false);
    expect(isRepoWideId(`${A}C4`)).toBe(false);
    expect(isRepoWideId(`${A}0131`)).toBe(false);
  });
});

describe("definedIds — what counts as a definition in a plan file", () => {
  it("accepts a heading, a bold bullet and a bold paragraph", () => {
    const text = [`### ${A}1: heading form`, `- **${A}2 — bullet form.** text`, `**${A}B2 (REVISED) — paragraph form.**`, `## ${A}2 AMENDMENT 1 — more`].join("\n");
    expect([...definedIds(text)]).toEqual([`${A}1`, `${A}2`, `${A}B2`]);
  });

  it("does not take a mention for a definition", () => {
    const text = [`### Phase 2 — re-add (${A}7)`, `- **${A}4 rewording.** changelog`, `Some prose citing ${A}9.`, "```", `### ${A}5 — inside a fence`, "```"].join("\n");
    expect([...definedIds(text)]).toEqual([]);
  });
});

describe("check-adr-refs — the gate", () => {
  it("passes when every citation resolves", () => {
    const res = run(repo(base({ "src/a.ts": `// three tiers (${A}013); the alias (${A}1)\n` })));
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\d+ citation\(s\) in 4 file\(s\) resolve to 1 record\(s\) and 2 plan-scoped id\(s\)/);
  });

  it("fails on a repository-wide id with no record, naming file and line", () => {
    const res = run(repo(base({ "AGENTS.md": `rules\n- layout (${A}014)\n` })));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(new RegExp(`AGENTS\\.md:2\\s+${A}014`));
  });

  it("fails on a plan-scoped id that no plan file defines", () => {
    const res = run(repo(base({ "src/a.rs": `//! decided in ${A}C9\n` })));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(new RegExp(`src/a\\.rs:1\\s+${A}C9`));
  });

  it("resolves a plan-scoped id defined by a tracked plan under .claude/tdd-guardian/", () => {
    const res = run(repo(base({ ".claude/tdd-guardian/plan.md": `## ADRs\n\n**${A}PDF1 — geometry travels.** text\n`, "src/a.rs": `// ${A}PDF1\n` })));
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });

  it("reads an untracked, not-ignored file — it is about to be committed", () => {
    const res = run(repo(base(), { untracked: { "new.md": `cites ${A}777\n` } }));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/new\.md:1/);
  });

  it("does not read a gitignored file", () => {
    const res = run(repo(base({ ".gitignore": "dev-docs/\n" }), { untracked: { "dev-docs/x.md": `cites ${A}777\n` } }));
    expect(res.status).toBe(0);
  });

  it("skips binary files instead of decoding them", () => {
    const dir = repo(base({ "img.bin": Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`${A}777`)]) }));
    expect(run(dir).status).toBe(0);
  });

  it("fails closed when .claude/adr/ holds no records at all", () => {
    const res = run(repo({ "src/a.ts": "// nothing cited\n" }));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no decision records/);
  });

  it("fails when a record's heading does not carry its own number", () => {
    const res = run(repo(base({ [`.claude/adr/${A}020-misfiled.md`]: record("021"), ".claude/adr/README.md": readme(`${A}013-service-tier.md`, `${A}020-misfiled.md`, "plans/20260101-a-plan.md") })));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(new RegExp(`${A}020-misfiled\\.md.*heading`));
  });

  it("fails when two records claim one number", () => {
    const res = run(repo(base({ [`.claude/adr/${A}013-again.md`]: record("013"), ".claude/adr/README.md": readme(`${A}013-service-tier.md`, `${A}013-again.md`, "plans/20260101-a-plan.md") })));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/two records/);
  });

  it("fails when a record is not linked from the index", () => {
    const res = run(repo(base({ ".claude/adr/README.md": readme(`${A}013-service-tier.md`) })));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/plans\/20260101-a-plan\.md.*not linked/);
  });

  it("fails when a plan file's Defines line disagrees with what it defines", () => {
    const lying = planFile(["1", "2"]).replace(`${A}1, ${A}2`, `${A}1, ${A}2, ${A}3`);
    const res = run(repo(base({ ".claude/adr/plans/20260101-a-plan.md": lying })));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(new RegExp(`Defines.*${A}3`));
  });

  it("--report lists how often each id is cited", () => {
    const count = (files) => Number(new RegExp(`${A}013\\s+(\\d+)`).exec(run(repo(files), "--report").stdout)[1]);
    // The record and the index cite the id too, so compare against the base tree.
    expect(count(base({ "a.md": `${A}013 ${A}013 ${A}2\n` })) - count(base())).toBe(2);
  });

  it("rejects an unknown flag and an empty --root with exit 64", () => {
    expect(spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" }).status).toBe(64);
    expect(spawnSync(process.execPath, [SCRIPT, "--root="], { encoding: "utf8" }).status).toBe(64);
  });
});
