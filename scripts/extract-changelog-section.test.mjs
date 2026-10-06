/**
 * WI-RA15B.6 — the release notes a tag ships come from its CHANGELOG.md
 * section, and a tag with no section fails the release instead of publishing
 * "See release notes at <url>" as the update card's "what's new" text.
 *
 * Fixtures pin the parser (version matching, section bounds, the plain-text
 * form the update card renders); the repository tests pin the two joins that
 * make it hold in practice — the tree's own version has a section, and
 * release.yml feeds the section to both the GitHub release and `latest.json`.
 *
 * @coordinates-with scripts/extract-changelog-section.mjs — the extractor
 * @coordinates-with .github/workflows/release.yml — its only production caller
 * @module scripts/extract-changelog-section.test
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { extractSection, listVersions, toPlainText } from "./extract-changelog-section.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts/extract-changelog-section.mjs");

const CHANGELOG = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Something not yet released.

## [0.9.10] - 2026-10-03

### Fixed

- The ten fix.

## [0.9.1] - 2026-09-01

### Added

- The one feature, with \`code\` and a [link](https://example.test).

### Fixed

- 修复了中文文件名的保存问题。

[Unreleased]: https://example.test/compare/v0.9.10...HEAD
[0.9.10]: https://example.test/releases/tag/v0.9.10
[0.9.1]: https://example.test/releases/tag/v0.9.1
`;

describe("extractSection", () => {
  it("returns the body under the version's heading, without the heading", () => {
    expect(extractSection(CHANGELOG, "0.9.10")).toBe("### Fixed\n\n- The ten fix.");
  });

  it("accepts the tag spelling with a leading v", () => {
    expect(extractSection(CHANGELOG, "v0.9.10")).toBe("### Fixed\n\n- The ten fix.");
  });

  it("does not let 0.9.1 match the 0.9.10 heading", () => {
    expect(extractSection(CHANGELOG, "0.9.1")).toMatch(/^### Added\n\n- The one feature/);
  });

  it("stops the last section before the link reference definitions", () => {
    const body = extractSection(CHANGELOG, "0.9.1");
    expect(body.endsWith("- 修复了中文文件名的保存问题。")).toBe(true);
    expect(body).not.toContain("[0.9.10]:");
  });

  it("reads CRLF files the same as LF files", () => {
    expect(extractSection(CHANGELOG.replace(/\n/g, "\r\n"), "0.9.10")).toBe("### Fixed\n\n- The ten fix.");
  });

  it("accepts a heading without a date", () => {
    expect(extractSection("## [1.0.0]\n\n- First.\n", "1.0.0")).toBe("- First.");
  });

  it("fails when the version has no section", () => {
    expect(() => extractSection(CHANGELOG, "0.9.2")).toThrow(
      "CHANGELOG.md has no section for 0.9.2 — add `## [0.9.2] - YYYY-MM-DD` with the release's changes",
    );
  });

  it("fails when the section is empty", () => {
    expect(() => extractSection("## [1.0.0] - 2026-01-01\n\n## [0.9.0]\n\n- x\n", "1.0.0")).toThrow(
      "CHANGELOG.md section 1.0.0 is empty",
    );
  });

  it("fails when the section holds headings but no entries", () => {
    expect(() => extractSection("## [1.0.0] - 2026-01-01\n\n### Added\n\n## [0.9.0]\n\n- x\n", "1.0.0")).toThrow(
      "CHANGELOG.md section 1.0.0 is empty",
    );
  });

  it("fails when a version has two sections", () => {
    expect(() => extractSection("## [1.0.0]\n\n- a\n\n## [1.0.0]\n\n- b\n", "1.0.0")).toThrow(
      "CHANGELOG.md has 2 sections for 1.0.0",
    );
  });

  it.each(["", "latest", "1.0", "v1.0.0.1", "Unreleased"])("rejects %j as a version", (version) => {
    expect(() => extractSection(CHANGELOG, version)).toThrow(/is not a release version/);
  });
});

describe("listVersions", () => {
  it("lists release headings in file order, skipping Unreleased", () => {
    expect(listVersions(CHANGELOG)).toEqual(["0.9.10", "0.9.1"]);
  });
});

describe("toPlainText", () => {
  it("renders headings as labels, bullets as dots, and drops markdown syntax", () => {
    const body = extractSection(CHANGELOG, "0.9.1");
    expect(toPlainText(body)).toBe(
      "Added\n• The one feature, with code and a link.\nFixed\n• 修复了中文文件名的保存问题。",
    );
  });

  it("keeps wrapped bullet lines joined to their bullet", () => {
    expect(toPlainText("### Fixed\n\n- A long entry that\n  wraps here.\n- Next.")).toBe(
      "Fixed\n• A long entry that wraps here.\n• Next.",
    );
  });

  it("keeps emphasis text and drops the markers", () => {
    expect(toPlainText("- **Bold** and _soft_ words.")).toBe("• Bold and soft words.");
  });
});

describe("the CLI", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "changelog-"));
  const file = path.join(dir, "CHANGELOG.md");
  writeFileSync(file, CHANGELOG);
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { code: error.status, out: String(error.stdout), err: String(error.stderr) };
    }
  };

  it("prints the markdown section for the release body", () => {
    expect(run(["v0.9.10", `--changelog=${file}`])).toEqual({ code: 0, out: "### Fixed\n\n- The ten fix.\n" });
  });

  it("prints the plain form for latest.json", () => {
    expect(run(["0.9.10", "--plain", `--changelog=${file}`])).toEqual({ code: 0, out: "Fixed\n• The ten fix.\n" });
  });

  it("exits 1 and names the version when the section is missing", () => {
    const result = run(["0.9.2", `--changelog=${file}`]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("no section for 0.9.2");
  });

  it("exits 64 on a bad invocation", () => {
    expect(run([]).code).toBe(64);
    expect(run(["1.0.0", "--bogus"]).code).toBe(64);
  });
});

describe("this repository", () => {
  const changelog = readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8");

  it("has a non-empty section for the version the tree declares", () => {
    const version = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
    expect(() => extractSection(changelog, version)).not.toThrow();
  });

  it("lists every release newest first, each with a non-empty section", () => {
    const versions = listVersions(changelog);
    expect(versions.length).toBeGreaterThan(0);
    const sorted = [...versions].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    expect(versions).toEqual(sorted);
    for (const v of versions) expect(() => extractSection(changelog, v)).not.toThrow();
  });
});

describe("the release workflow", () => {
  const jobs = parseYaml(readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8")).jobs;
  const step = (job, name) => jobs[job].steps.find((s) => s.name === name);

  it("fails before the draft exists when the tag has no CHANGELOG section", () => {
    const steps = jobs["create-release"].steps;
    const extract = steps.findIndex((s) => s.name === "Extract release notes from CHANGELOG.md");
    const create = steps.findIndex((s) => s.name === "Create Release");
    expect(extract, "create-release must extract the notes").toBeGreaterThan(-1);
    expect(extract).toBeLessThan(create);
    expect(steps[extract].run).toContain("node scripts/extract-changelog-section.mjs");
    expect(steps[create].with.body_path).toBe("release-notes.md");
  });

  it("puts the plain section into latest.json instead of a link", () => {
    const publish = step("publish-release", "Generate and upload latest.json");
    expect(publish.run).not.toContain("See release notes at");
    expect(publish.run).toContain("node scripts/extract-changelog-section.mjs \"$VERSION\" --plain");
    expect(publish.run).toContain('--arg notes "$NOTES"');
    expect(jobs["publish-release"].steps.findIndex((s) => s.uses?.startsWith("actions/checkout"))).toBe(0);
  });
});
