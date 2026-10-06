/**
 * Calendar dates and maintainer-local paths in production comments — the
 * second half of `scripts/check-provenance-ids.mjs`.
 *
 * Purpose: a production comment says why the code is the way it is, and that
 * reason has to hold for a reader of a fresh clone at any later time. Two
 * kinds of citation fail that test, and this module finds both:
 *   - A CALENDAR DATE ("measured on <date>", "maintainer direction <date>",
 *     "until <date>") ages the moment it is written: it says when, which a
 *     reader cannot use, instead of what was observed, which they can. Rule 22
 *     forbids dates in code comments.
 *   - A `dev-docs/` PATH names a maintainer-local, gitignored file that no
 *     clone has, so the reason it points to is unreadable everywhere but one
 *     machine.
 *
 * What is NOT a finding:
 *   - A date that is part of an identifier: inside a path or a file name
 *     (`.claude/adr/plans/<date>-name.md`), or the date of a dated audit
 *     citation (`audit <date> #84`) that the provenance rules accept because a
 *     tracked audit record carries that date.
 *   - A `dev-docs/` path the file's own CODE uses — a script that writes a
 *     generated report under `dev-docs/` or asserts a fixture there describes
 *     its subject when its comment names that path. Nor is the directory
 *     itself or one of its top-level convention folders (`dev-docs/plans`):
 *     those name where documents go, not a document.
 *
 * Key decisions:
 *   - Dates are matched as dates — a valid month and day, years 2000–2099 —
 *     in the forms this tree has used: `YYYY-MM-DD`, `YYYYMMDD`,
 *     `YYYY/MM/DD`, `YYYY-MM`, and month-name forms (`<Month> <D>, <YYYY>`,
 *     `<D> <Month> <YYYY>`, `<Month> <YYYY>`). A bare year is not a date.
 *   - Shell scripts are read line-wise (`sourceComments.mjs`): whole-line `#`
 *     comments outside heredocs. Their trailing comments are not read.
 *   - Scope is production source plus the tooling (`scripts/`,
 *     `.claude/hooks/`), which is production code for these rules; tests and
 *     fixtures are not.
 *
 * @coordinates-with scripts/lib/provenanceIds.mjs — the trees, the test-path rule, audit-token spans and tracked audit dates
 * @coordinates-with scripts/lib/sourceComments.mjs — every comment of a file, shell included
 * @coordinates-with scripts/check-provenance-ids.mjs — the CLI that reports these findings
 * @coordinates-with scripts/check-provenance-ids.test.mjs — drives every rule here
 * @module scripts/lib/commentCitations
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { COMMENT_RULE_TREES, auditDates, isRuleSource, productionFiles, tokensIn } from "./provenanceIds.mjs";
import { commentRuns, lineAt } from "./sourceComments.mjs";

const MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
const MM = String.raw`(?:0[1-9]|1[0-2])`;
const DD = String.raw`(?:0[1-9]|[12]\d|3[01])`;
const YEAR = String.raw`20\d\d`;
const DATE_RE = new RegExp(
  [
    String.raw`(?<![\w])${YEAR}-${MM}-${DD}(?![\d])`,
    String.raw`(?<![\w])${YEAR}${MM}${DD}(?![\d])`,
    String.raw`(?<![\w])${YEAR}/${MM}/${DD}(?![\d])`,
    String.raw`(?<![\w-])${YEAR}-${MM}(?![\d-])`,
    String.raw`\b${MONTH}\.? \d{1,2}(?:st|nd|rd|th)?,? ${YEAR}\b`,
    String.raw`\b\d{1,2} ${MONTH} ${YEAR}\b`,
    String.raw`\b${MONTH} ${YEAR}\b`,
  ].join("|"),
  "g",
);

/** The whitespace-delimited word around `[start, end)` in `text`, without wrapping punctuation. */
function wordAround(text, start, end) {
  let s = start;
  let e = end;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return text.slice(s, e).replace(/^[`"'(\[<*]+/, "").replace(/[`"')\]>,;:.]+$/, "");
}

/**
 * True when the date sits inside a path or a file name — an identifier, not a
 * statement of when. Judged on the word with the date itself taken out, so the
 * slashes of a `YYYY/MM/DD` date do not make it a path.
 */
function inPathOrFileName(text, start, end) {
  const word = wordAround(text, start, end);
  const rest = word.replace(text.slice(start, end), "\u0000");
  return rest.includes("/") || /\.[A-Za-z][\w]{0,5}$/.test(rest);
}

/**
 * The dates in one comment's text that are findings: `{ token, index }`.
 * `auditRecordDates` is the set of `YYYYMMDD` dates a tracked audit record carries.
 */
export function datesIn(text, auditRecordDates = new Set()) {
  const exempt = tokensIn(text).filter((t) => t.kind === "audit" && t.date && auditRecordDates.has(t.date));
  const out = [];
  for (const m of text.matchAll(DATE_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (exempt.some((t) => start >= t.index && end <= t.end)) continue;
    if (inPathOrFileName(text, start, end)) continue;
    out.push({ token: m[0], index: start });
  }
  return out;
}

const DEV_DOCS_RE = /(?<![\w.-])(?:\.\.?\/)*dev-docs\/([^\s`'"()<>\[\],;]*)/g;

/** A trailing full stop, a glob or a trailing slash is cut, leaving the path the comment names. */
function normalizeDevDocsPath(raw) {
  return raw
    .replace(/^(?:\.\.?\/)+/, "")
    .replace(/\*.*$/, "")
    .replace(/[.:]+$/, "")
    .replace(/\/+$/, "");
}

/**
 * A path that names DOCUMENTS: a file (its last segment has an extension) or
 * a folder below the top level. `dev-docs` and its top-level convention
 * folders (`dev-docs/plans`, `dev-docs/grills`) name where things go, which is
 * a fact about the layout AGENTS.md documents, not a citation.
 */
function namesDocuments(target) {
  const segments = target.split("/").slice(1);
  return segments.length >= 2 || /\.[A-Za-z]\w*$/.test(segments.at(-1) ?? "");
}

/**
 * The `dev-docs/` document paths in one comment's text that are findings:
 * `{ token, index }`. `code` is the file with its comments blanked; a path the
 * code itself uses is the file's subject, not a citation.
 */
export function devDocsPathsIn(text, code = "") {
  const out = [];
  for (const m of text.matchAll(DEV_DOCS_RE)) {
    const target = normalizeDevDocsPath(m[0]);
    if (!namesDocuments(target)) continue;
    if (code.includes(target)) continue;
    out.push({ token: target, index: m.index });
  }
  return out;
}

/** `source` with every comment replaced by spaces (newlines kept) — what the file's code says. */
function codeOnly(source, spans) {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += source.slice(at, s.start) + source.slice(s.start, s.end).replace(/[^\n]/g, " ");
    at = s.end;
  }
  return out + source.slice(at);
}

/** Every date and `dev-docs/` finding in the production comments under `root`: `{ kind, file, line, token, reason }`. */
export function scanCitations(root, trees = COMMENT_RULE_TREES) {
  const dates = auditDates(root);
  const out = [];
  for (const file of productionFiles(root, trees, isRuleSource)) {
    const source = readFileSync(path.join(root, file), "utf8");
    if (!/20\d\d|dev-docs\//.test(source)) continue;
    const spans = commentRuns(source, file);
    const code = source.includes("dev-docs/") ? codeOnly(source, spans) : "";
    for (const c of spans) {
      for (const d of datesIn(c.text, dates)) {
        out.push({ kind: "date", file, line: lineAt(source, c.start + d.index), token: d.token, reason: "a calendar date in a production comment — state what was observed or decided instead" });
      }
      for (const p of devDocsPathsIn(c.text, code)) {
        out.push({ kind: "dev-docs", file, line: lineAt(source, c.start + p.index), token: p.token, reason: "a maintainer-local dev-docs/ path no clone can read — state the reason, or cite a tracked file" });
      }
    }
  }
  return out;
}
