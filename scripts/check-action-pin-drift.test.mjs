// WI-RA13B.7 — one action, one pinned commit, in every workflow and composite action.
/**
 * Dependabot bumps each file that carries an action pin in its own pull
 * request, and a composite action under `.github/actions/` is a separate
 * entry from the workflows. When one of those bumps lands and the other does
 * not, the same action runs at two versions depending on which job reaches
 * it — `pnpm/action-setup` ran one release behind in the shared setup action
 * while every workflow had moved on. Nothing turns red for that, so it is
 * asserted here: every SHA-pinned reference to one action names one commit.
 *
 * @coordinates-with scripts/check-supply-chain-pins.test.mjs — the SHA-pin rule this builds on
 * @coordinates-with .github/workflows — every `uses:` line
 * @coordinates-with .github/actions — composite actions
 * @module scripts/check-action-pin-drift.test
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function yamlFilesUnder(dir) {
  return readdirSync(path.join(REPO, dir))
    .flatMap((name) => {
      const rel = path.join(dir, name);
      if (statSync(path.join(REPO, rel)).isDirectory()) return yamlFilesUnder(rel);
      return /\.ya?ml$/.test(name) ? [rel] : [];
    })
    .sort();
}

/** `action → Map(sha → [file:line])` for every SHA-pinned `uses:` line. */
export function pinsByAction(files) {
  const pins = new Map();
  for (const { file, text } of files) {
    text.split(/\r?\n/).forEach((raw, index) => {
      const match = raw.match(/^\s*(?:-\s*)?uses:\s*["']?([^@\s"']+)@([0-9a-f]{40})\b/);
      if (!match) return;
      const [, action, sha] = match;
      if (!pins.has(action)) pins.set(action, new Map());
      const bySha = pins.get(action);
      bySha.set(sha, [...(bySha.get(sha) ?? []), `${file}:${index + 1}`]);
    });
  }
  return pins;
}

/** Actions pinned to more than one commit, with every site per commit. */
export function driftedPins(pins) {
  return [...pins]
    .filter(([, bySha]) => bySha.size > 1)
    .map(([action, bySha]) => ({ action, sites: Object.fromEntries(bySha) }));
}

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("driftedPins", () => {
  it("reports an action pinned to two commits, naming every site", () => {
    const pins = pinsByAction([
      { file: "w.yml", text: `      - uses: pnpm/action-setup@${A} # v6.1.0\n` },
      { file: "a.yml", text: `    - uses: "pnpm/action-setup@${B}" # v6\r\n` },
    ]);
    expect(driftedPins(pins)).toEqual([
      { action: "pnpm/action-setup", sites: { [A]: ["w.yml:1"], [B]: ["a.yml:1"] } },
    ]);
  });

  it("accepts one action pinned to one commit everywhere, and ignores tags and prose", () => {
    const pins = pinsByAction([
      { file: "w.yml", text: `- uses: x/y@${A} # v1\n# uses: x/y@${B}\n- uses: actions/checkout@v4\n` },
      { file: "a.yml", text: `  uses: x/y@${A} # v1\n` },
    ]);
    expect(driftedPins(pins)).toEqual([]);
  });
});

describe("the repository's action pins", () => {
  const files = [...yamlFilesUnder(".github/workflows"), ...yamlFilesUnder(".github/actions")].map((file) => ({
    file,
    text: readFileSync(path.join(REPO, file), "utf8"),
  }));

  it("reads the composite actions as well as the workflows", () => {
    expect(files.some((f) => f.file.startsWith(".github/actions/"))).toBe(true);
    expect(pinsByAction(files).size).toBeGreaterThan(3);
  });

  it("pins each action to a single commit", () => {
    expect(driftedPins(pinsByAction(files))).toEqual([]);
  });
});
