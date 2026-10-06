// @vitest-environment node
// WI-RA1C.4 — architecture-fitness test: per-tab state is freed in ONE place.
//
// A tab that leaves the tab store takes its document, revision, history and
// the rest of its per-tab state with it, because the tab-state cleanup
// subscribes to the removal announcement. Sites that removed a tab used to
// free part of that state themselves — the document only, or the document and
// its history — which hid whether the announcement reached anyone, and left
// the rest behind wherever the subscriber was not running.
//
// This test keeps removal sites from growing their own cleanup again: outside
// the cleanup module, no production file removes a document or calls the
// cleanup function.
//
// Limitation: it reads call text, so it catches the realistic regression (a
// site calling `removeDocument` next to its `closeTab`), not a removal routed
// through some new helper. The behaviour is pinned where the removals happen
// (services/tabs/tabRemovalSites.test.ts, services/windowClose/tabStateCleanup.test.ts).
//
// @coordinates-with services/windowClose/tabCleanup.ts — the one owner
// @coordinates-with stores/tabRemovalBus.ts — the announcement it subscribes to

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(import.meta.dirname, "..", "..");
const OWNER = "services/windowClose/tabCleanup.ts";

const SKIPPED_DIRS = new Set(["__tests__", "__mocks__", "test", "node_modules"]);

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(name) || /\.testUtils\.tsx?$/.test(name) || name.endsWith(".d.ts");
}

/** Every production .ts/.tsx file under `src/`, as a `/`-separated path from it. */
function productionSources(dir: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) out.push(...productionSources(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || isTestFile(entry)) continue;
    out.push(relative(SRC_ROOT, full).split(sep).join("/"));
  }
  return out;
}

/** Comments name the forbidden calls to explain the rule; only code counts. */
function code(file: string): string {
  return readFileSync(join(SRC_ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Production files, other than the owner, whose code matches `pattern`. */
function filesCalling(pattern: RegExp): string[] {
  return productionSources()
    .filter((file) => file !== OWNER)
    .filter((file) => pattern.test(code(file)))
    .sort();
}

describe("per-tab state has one owner", () => {
  it("scans the production tree, and the owner is in it", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toContain(OWNER);
    expect(code(OWNER)).toMatch(/\.removeDocument\(/);
  });

  it("only the tab-state cleanup removes a document", () => {
    expect(filesCalling(/\.removeDocument\(/)).toEqual([]);
  });

  it("only the removal subscriber calls the cleanup", () => {
    expect(filesCalling(/\bcleanupTabState\(/)).toEqual([]);
  });
});
