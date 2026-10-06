#!/usr/bin/env node
/**
 * Print a release's CHANGELOG.md section — the release notes a tag ships.
 *
 * The release workflow used to publish GitHub's auto-generated PR list as the
 * release body and the literal string "See release notes at <url>" as the
 * `latest.json` `notes`, which the in-app update card renders as its "what's
 * new" text. Notes now come from one place, written at bump time
 * (`.claude/rules/40-version-bump.md`), and a tag with no section fails the
 * release before the draft is created rather than shipping a link.
 *
 * Sections follow Keep a Changelog: `## [x.y.z] - YYYY-MM-DD` (the date is
 * optional), ending at the next `## ` heading; link reference definitions
 * after the last section are not part of it. `## [Unreleased]` is never a
 * release. A section with no entry line (only `### Added`-style headings) is
 * empty, and empty fails like missing.
 *
 * Usage: node scripts/extract-changelog-section.mjs <version> [--plain] [--changelog=<path>]
 *   <version>  `1.2.3` or the tag spelling `v1.2.3`
 *   --plain    the update card's form: headings as labels, bullets as `•`,
 *              markdown syntax dropped (it renders text, not markdown)
 *   exit 0 printed, 1 no usable section, 64 bad invocation
 *
 * @coordinates-with .github/workflows/release.yml — the release body and latest.json notes
 * @coordinates-with src/pages/settings/UpdateAvailableCard.tsx — renders the --plain form
 * @coordinates-with scripts/extract-changelog-section.test.mjs — the self-test
 * @module scripts/extract-changelog-section
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/isMainModule.mjs";

const USAGE = "Usage: node scripts/extract-changelog-section.mjs <version> [--plain] [--changelog=<path>]";
const VERSION = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const RELEASE_HEADING = /^## \[([^\]]+)\](?:\s+-\s+\S.*)?\s*$/;
const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S+/;

function lines(text) {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** `[{version, start, end}]` for every `## [...]` heading, `end` exclusive. */
function sections(text) {
  const all = lines(text);
  const found = [];
  all.forEach((line, i) => {
    if (line.startsWith("## ")) {
      if (found.length > 0) found[found.length - 1].end = i;
      found.push({ version: RELEASE_HEADING.exec(line)?.[1] ?? null, start: i + 1, end: all.length });
    }
  });
  return { all, found };
}

/** Release versions with a section, in file order (Unreleased excluded). */
export function listVersions(text) {
  return sections(text)
    .found.map((s) => s.version)
    .filter((v) => v !== null && v !== "Unreleased");
}

/**
 * The markdown body of `version`'s section, trimmed. Throws when the version
 * is malformed, has no section, has two, or its section has no entry.
 */
export function extractSection(text, version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`${JSON.stringify(version)} is not a release version (x.y.z or vx.y.z)`);
  const wanted = match[1];
  const { all, found } = sections(text);
  const hits = found.filter((s) => s.version === wanted);
  if (hits.length === 0) {
    throw new Error(`CHANGELOG.md has no section for ${wanted} — add \`## [${wanted}] - YYYY-MM-DD\` with the release's changes`);
  }
  if (hits.length > 1) throw new Error(`CHANGELOG.md has ${hits.length} sections for ${wanted}`);
  const body = all.slice(hits[0].start, hits[0].end);
  while (body.length > 0 && (body.at(-1).trim() === "" || LINK_DEFINITION.test(body.at(-1)))) body.pop();
  while (body.length > 0 && body[0].trim() === "") body.shift();
  if (!body.some((line) => line.trim() !== "" && !line.startsWith("#"))) {
    throw new Error(`CHANGELOG.md section ${wanted} is empty`);
  }
  return body.join("\n");
}

/** Inline markdown to text: code spans, links, emphasis. */
function inlineText(text) {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])([*_])(?!\s)(.+?)(?<!\s)\2(?![\w*])/g, "$1$3");
}

/** The section as the update card shows it: one line per heading or entry. */
export function toPlainText(markdown) {
  const out = [];
  for (const raw of lines(markdown)) {
    const line = raw.trim();
    if (line === "") continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (heading) out.push(inlineText(heading[1]));
    else if (bullet) out.push(`• ${inlineText(bullet[1])}`);
    else if (out.length > 0 && /^\s+\S/.test(raw)) out[out.length - 1] += ` ${inlineText(line)}`;
    else out.push(inlineText(line));
  }
  return out.join("\n");
}

function parseArgs(argv, repo) {
  const opts = { version: null, plain: false, changelog: path.join(repo, "CHANGELOG.md") };
  for (const a of argv) {
    if (a === "--plain") opts.plain = true;
    else if (a.startsWith("--changelog=") && a.length > "--changelog=".length) opts.changelog = path.resolve(a.slice("--changelog=".length));
    else if (!a.startsWith("--") && opts.version === null) opts.version = a;
    else throw new Error(`unexpected argument ${JSON.stringify(a)}\n${USAGE}`);
  }
  if (opts.version === null) throw new Error(`missing <version>\n${USAGE}`);
  return opts;
}

function main() {
  const repo = path.resolve(import.meta.dirname, "..");
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), repo);
  } catch (error) {
    console.error(error.message);
    process.exit(64);
  }
  try {
    const body = extractSection(readFileSync(opts.changelog, "utf8"), opts.version);
    process.stdout.write(`${opts.plain ? toPlainText(body) : body}\n`);
  } catch (error) {
    console.error(`extract-changelog-section: ${error.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
