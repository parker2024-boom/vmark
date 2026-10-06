// WI-RA16.2 — third-party actions stay pinned by commit SHA, Dependabot can
// see every file that carries a pin, and pnpm refuses freshly published
// releases.
/**
 * Three supply-chain settings that fail silently when they drift.
 *
 * 1. A third-party action referenced by tag (`owner/action@v3`) runs whatever
 *    the tag points at today. Nothing turns red when someone adds one, so the
 *    pin is asserted here. First-party `actions/*` and local `./` actions are
 *    exempt: the first is GitHub's own namespace, the second is this repo.
 * 2. Dependabot's `github-actions` ecosystem with `directory: /` reads
 *    `.github/workflows` only. A composite action under `.github/actions/`
 *    is invisible to it unless its directory is listed, and a pin nobody
 *    updates is a pin that rots: it stays green and stays old.
 * 3. `minimumReleaseAge` makes pnpm refuse a version published too recently
 *    to have been noticed if it was malicious. Dependabot's npm cooldown must
 *    be at least as long, or it proposes versions pnpm will not resolve.
 *
 * @coordinates-with .github/workflows — every `uses:` line
 * @coordinates-with .github/dependabot.yml
 * @coordinates-with pnpm-workspace.yaml
 * @module scripts/check-supply-chain-pins.test
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINUTES_PER_DAY = 24 * 60;

/** The shortest release age that is still worth having, in days. */
const MIN_RELEASE_AGE_DAYS = 7;

/** Every YAML file under `dir`, repo-relative, sorted. */
function yamlFilesUnder(dir) {
  const abs = path.join(REPO, dir);
  return readdirSync(abs)
    .flatMap((name) => {
      const rel = path.join(dir, name);
      if (statSync(path.join(REPO, rel)).isDirectory()) return yamlFilesUnder(rel);
      return /\.ya?ml$/.test(name) ? [rel] : [];
    })
    .sort();
}

/**
 * The `uses:` references in a workflow or action file that are neither pinned
 * by a full commit SHA nor exempt, as `{ line, ref, why }`.
 *
 * Works on the raw text because the version comment is part of the contract
 * and a YAML parser discards comments.
 */
function unpinnedUses(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const match = raw.match(/^\s*(?:-\s*)?uses:\s*(\S+)\s*(#.*)?$/);
    if (!match) return;
    const ref = match[1].replace(/^["']|["']$/g, "");
    const comment = (match[2] ?? "").replace(/^#\s*/, "").trim();
    if (ref.startsWith("./") || ref.startsWith("actions/")) return;
    const line = index + 1;
    const at = ref.lastIndexOf("@");
    const revision = at === -1 ? "" : ref.slice(at + 1);
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      problems.push({ line, ref, why: "not pinned by a 40-character commit SHA" });
    } else if (comment === "") {
      problems.push({ line, ref, why: "no trailing comment naming the version" });
    }
  });
  return problems;
}

describe("unpinnedUses", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("accepts a SHA pin with a version comment, in both step spellings", () => {
    expect(unpinnedUses(`      - uses: owner/tool@${sha} # v1.2.3`)).toEqual([]);
    expect(unpinnedUses(`        uses: owner/tool/sub/path@${sha} # v1`)).toEqual([]);
  });

  it("exempts first-party and local actions", () => {
    expect(unpinnedUses("      - uses: actions/checkout@v7")).toEqual([]);
    expect(unpinnedUses("      - uses: ./.github/actions/setup-node-pnpm")).toEqual([]);
  });

  it("rejects a tag, a branch, a short SHA and a missing revision", () => {
    for (const ref of ["owner/tool@v3", "owner/tool@main", "owner/tool@0123456", "owner/tool"]) {
      expect(unpinnedUses(`      - uses: ${ref} # v3`), ref).toEqual([
        { line: 1, ref, why: "not pinned by a 40-character commit SHA" },
      ]);
    }
  });

  it("rejects an uppercase or over-long revision, which is not a commit SHA", () => {
    expect(unpinnedUses(`- uses: owner/tool@${sha.toUpperCase()} # v1`)).toHaveLength(1);
    expect(unpinnedUses(`- uses: owner/tool@${sha}0 # v1`)).toHaveLength(1);
  });

  it("rejects a SHA pin with no version comment", () => {
    expect(unpinnedUses(`      - uses: owner/tool@${sha}`)).toEqual([
      { line: 1, ref: `owner/tool@${sha}`, why: "no trailing comment naming the version" },
    ]);
    expect(unpinnedUses(`      - uses: owner/tool@${sha} #`)).toHaveLength(1);
  });

  it("reads quoted references and CRLF files, and reports the line number", () => {
    expect(unpinnedUses(`jobs:\r\n  a:\r\n    steps:\r\n      - uses: "owner/tool@v2"\r\n`)).toEqual([
      { line: 4, ref: "owner/tool@v2", why: "not pinned by a 40-character commit SHA" },
    ]);
  });

  it("ignores a `uses:` that only appears inside prose", () => {
    expect(unpinnedUses("      # the old step was uses: owner/tool@v3")).toEqual([]);
    expect(unpinnedUses("")).toEqual([]);
  });
});

const actionFiles = [...yamlFilesUnder(".github/workflows"), ...yamlFilesUnder(".github/actions")];

describe("third-party actions are pinned by commit SHA", () => {
  it("finds the workflow and action files it is supposed to read", () => {
    expect(actionFiles.length).toBeGreaterThan(10);
    const references = actionFiles.flatMap((file) =>
      readFileSync(path.join(REPO, file), "utf8").match(/uses:\s*\S+@[0-9a-f]{40}/g) ?? [],
    );
    expect(references.length, "no SHA-pinned action was found at all").toBeGreaterThan(0);
  });

  it.each(actionFiles)("%s", (file) => {
    expect(unpinnedUses(readFileSync(path.join(REPO, file), "utf8"))).toEqual([]);
  });
});

const dependabot = parse(readFileSync(path.join(REPO, ".github/dependabot.yml"), "utf8"));
const entryFor = (ecosystem) => dependabot.updates.filter((u) => u["package-ecosystem"] === ecosystem);

describe("Dependabot can see every file that carries an action pin", () => {
  const entries = entryFor("github-actions");

  it("has exactly one github-actions entry", () => {
    expect(entries).toHaveLength(1);
  });

  it("lists the workflow root and every composite action directory", () => {
    const compositeDirs = yamlFilesUnder(".github/actions")
      .filter((file) => /(^|\/)action\.ya?ml$/.test(file))
      .map((file) => `/${path.dirname(file).split(path.sep).join("/")}`);
    expect(compositeDirs.length).toBeGreaterThan(0);
    const listed = entries[0].directories ?? [entries[0].directory];
    expect([...listed].sort()).toEqual(["/", ...compositeDirs].sort());
  });
});

describe("pnpm refuses freshly published releases", () => {
  const workspace = parse(readFileSync(path.join(REPO, "pnpm-workspace.yaml"), "utf8"));

  it("sets minimumReleaseAge, in minutes, to at least a week", () => {
    expect(Number.isInteger(workspace.minimumReleaseAge)).toBe(true);
    expect(workspace.minimumReleaseAge).toBeGreaterThanOrEqual(MIN_RELEASE_AGE_DAYS * MINUTES_PER_DAY);
  });

  it("carries no exclusions, so no package skips the wait unreviewed", () => {
    expect(workspace.minimumReleaseAgeExclude ?? []).toEqual([]);
  });

  it("Dependabot's npm cooldown is at least as long, so it never proposes a version pnpm refuses", () => {
    const npm = entryFor("npm");
    expect(npm).toHaveLength(1);
    const cooldownDays = npm[0].cooldown?.["default-days"];
    expect(Number.isInteger(cooldownDays)).toBe(true);
    expect(cooldownDays * MINUTES_PER_DAY).toBeGreaterThanOrEqual(workspace.minimumReleaseAge);
  });
});
