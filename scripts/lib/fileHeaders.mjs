/**
 * The file-header grammar for production TypeScript under `src/` — the pure
 * half of `scripts/check-file-headers.mjs`.
 *
 * Purpose: decide, from a file's path and text alone, whether it opens with
 * the header rule 22 defines, and say what is wrong when it does not. A
 * header is the file's own `/** … *​/` block: the first bytes of the file,
 * prose that says what the file is for, exactly one `@module` naming the
 * file's real path, and a blank line after it.
 *
 * Key decisions:
 *   - The grammar is the one most of the tree already wrote, and the one the
 *     header-reference gate already parses: a leading JSDoc block carrying
 *     `@module`. Nothing new to learn, and `@module` correctness reuses
 *     `expectedModulePaths` so the two gates cannot disagree on a path.
 *   - What follows the block is what makes it the FILE's header: a blank line
 *     or an import / re-export. A block directly above a declaration is that
 *     declaration's doc comment — the editor's hover shows it on the export,
 *     and a file whose only leading comment documents `cn()` has no header.
 *   - "Says what the file is for" cannot be checked by a script. What can be
 *     is that the block holds prose — five or more words outside its tag
 *     lines — so a block that is only a title or only tags fails.
 *   - Subjects are the file-size gate's production set: test, bench and mock
 *     files (`isTestFile`) are not subjects, nor are declaration files
 *     (`.d.ts`) or marked generated files (`isGenerated`).
 *   - `@module` is counted over the whole file's comments, literal-aware, so a
 *     second header lower down — two stacked headers after a merge — is a
 *     finding rather than a second, unchecked claim.
 *
 * @coordinates-with scripts/check-file-headers.mjs — the CLI over these functions
 * @coordinates-with scripts/check-file-headers.test.mjs — drives every rule here
 * @coordinates-with scripts/lib/headerReferences.mjs — `expectedModulePaths`, the one notion of a module path
 * @coordinates-with scripts/check-file-size.mjs — the test/generated classification reused here
 * @coordinates-with .claude/rules/22-comment-maintenance.md — the rule this enforces
 * @module scripts/lib/fileHeaders
 */
import { isGenerated, isTestFile } from "../check-file-size.mjs";
import { extractReferences } from "./headerComments.mjs";
import { expectedModulePaths } from "./headerReferences.mjs";
import { fsAt, walkSources } from "./headerReferenceTrees.mjs";

/** The tree whose files must carry the header. */
const HEADER_TREE = "src";
/** Fewest words of prose (outside tag lines) a header may hold. */
export const MIN_PROSE_WORDS = 5;

/** Is `rel` (repo-relative, POSIX) a file this grammar applies to? */
export function isHeaderSubject(rel, source) {
  if (!rel.startsWith(`${HEADER_TREE}/`) || !/\.tsx?$/.test(rel)) return false;
  if (rel.endsWith(".d.ts") || isTestFile(rel)) return false;
  return !isGenerated(rel, source);
}

/** The leading block's text lines, markers stripped, or `null` when the file does not open with `/**`. */
function leadingBlock(source) {
  if (!source.startsWith("/**")) return null;
  const close = source.indexOf("*/", 3);
  if (close === -1) return null;
  const lines = source
    .slice(3, close)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd());
  return { lines, rest: source.slice(close + 2) };
}

/**
 * Is the block the FILE's (see header)? The `*​/` line ends there, and what
 * follows is nothing, a blank line, or an import / re-export — statements no
 * doc comment documents.
 */
function isDetached(rest) {
  if (rest.trim() === "") return true;
  const m = /^[ \t]*\r?\n([^\r\n]*)/.exec(rest);
  if (!m) return false;
  const next = m[1].trim();
  return next === "" || /^(?:import\b|export\s*(?:\*|\{|type\s*\{))/.test(next);
}

/** The header problems of one subject file; an empty array means it conforms. */
export function headerProblems(rel, source, fs) {
  const block = leadingBlock(source);
  if (!block) {
    return [source.startsWith("/*") ? "the file opens with a block comment that is not a `/**` header" : "the file does not open with a `/** … */` header"];
  }
  const problems = [];
  if (!isDetached(block.rest)) {
    problems.push("the header documents the first declaration — end the `*/` line, then leave a blank line (an import may follow directly)");
  }
  const prose = block.lines.filter((l) => l.trim() !== "" && !/^\s*@/.test(l));
  const words = prose.join(" ").split(/\s+/).filter(Boolean).length;
  if (words < MIN_PROSE_WORDS) {
    problems.push(`the header has ${words} word(s) of prose; say what the file is for in at least ${MIN_PROSE_WORDS}`);
  }
  const inHeader = block.lines.filter((l) => /^@module\b/.test(l.trim()));
  const everywhere = extractReferences(source, rel).filter((r) => r.kind === "module-self");
  if (inHeader.length === 0) problems.push("the header has no `@module` line");
  if (everywhere.length > 1) problems.push(`the file carries ${everywhere.length} \`@module\` lines; keep exactly one, in the header`);
  if (inHeader.length === 1) {
    const value = inHeader[0].trim().replace(/^@module\s*/, "").split(/\s+/)[0] ?? "";
    const expected = expectedModulePaths(rel, fs);
    if (!expected.has(value)) problems.push(`\`@module ${value}\` does not name this file; expected \`@module ${[...expected][0]}\``);
  }
  return problems;
}

/** Every finding under `root`: `{ file, problem }`, in path order, plus the subject count. */
export function scanHeaders(root) {
  const fs = fsAt(root);
  const findings = [];
  let files = 0;
  if (!fs.isDir(HEADER_TREE)) throw new Error(`no ${HEADER_TREE}/ directory under ${root}`);
  for (const rel of walkSources(fs, HEADER_TREE)) {
    const source = fs.read(rel);
    if (!isHeaderSubject(rel, source)) continue;
    files++;
    for (const problem of headerProblems(rel, source, fs)) findings.push({ file: rel, problem });
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files, findings };
}
