// WI-RA15C.10 — the website's CJK demo runs the app's formatter, not a fork.
// Self-test for scripts/check-cjk-demo-parity.mjs (first written for WI-CJKF7.2).
//
// The gate is only worth having if it FAILS on the drift it was built for, so
// each failure is exercised against a synthetic tree (an in-memory file map)
// rather than against the repository's own files, which are, by design, clean.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEMO_COMPONENT,
  RULES_ENTRY,
  SITE_ALIASES,
  SITE_CONFIG,
  checkTree,
  demoImportFailures,
  forkFailures,
  runtimeAppImports,
} from "./check-cjk-demo-parity.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEMO_OK = [
  "<script setup lang=\"ts\">",
  "import { applyRules } from '../../../../src/lib/cjkFormatter/rules/applyRules'",
  "import { DEFAULT_CJK_FORMATTING } from '../../../../src/lib/cjkFormatter/types'",
  "</script>",
].join("\n");

const CONFIG_OK = 'const APP_LOGGER = "@/utils/debug";';

/** A minimal clean tree: the rule chain reaches one app import the site stands in for. */
function cleanTree(overrides = {}) {
  return {
    [RULES_ENTRY]: 'import type { X } from "../types";\nimport { cjkFmtWarn } from "@/utils/debug";\nimport { a } from "./shared";\n',
    "src/lib/cjkFormatter/rules/shared.ts": "export const a = 1;\n",
    [DEMO_COMPONENT]: DEMO_OK,
    [SITE_CONFIG]: CONFIG_OK,
    ...overrides,
  };
}
const reader = (files) => (rel) => files[rel];

describe("runtimeAppImports", () => {
  it("collects the runtime @/ imports reachable from the entry, through relative imports", () => {
    const files = cleanTree({
      "src/lib/cjkFormatter/rules/shared.ts": 'import { t } from "@/utils/tableParser";\nexport const a = 1;\n',
    });
    expect([...runtimeAppImports(RULES_ENTRY, reader(files))].sort()).toEqual(["@/utils/debug", "@/utils/tableParser"]);
  });

  it("ignores type-only imports, which the build erases", () => {
    const files = cleanTree({
      [RULES_ENTRY]: 'import type { QuoteStyle } from "@/stores/settingsStore";\nimport { cjkFmtWarn } from "@/utils/debug";\n',
    });
    expect([...runtimeAppImports(RULES_ENTRY, reader(files))]).toEqual(["@/utils/debug"]);
  });

  it("follows `export … from` re-exports and multi-line import lists", () => {
    const files = cleanTree({
      [RULES_ENTRY]: 'import {\n  a,\n  b,\n} from "./shared";\nexport { c } from "./more";\n',
      "src/lib/cjkFormatter/rules/more.ts": 'import { s } from "@/stores/settingsStore";\nexport const c = s;\n',
    });
    expect([...runtimeAppImports(RULES_ENTRY, reader(files))]).toEqual(["@/stores/settingsStore"]);
  });

  it("fails closed when a relative import names no file", () => {
    const files = cleanTree({ [RULES_ENTRY]: 'import { gone } from "./gone";\n' });
    expect(() => runtimeAppImports(RULES_ENTRY, reader(files))).toThrow(/cannot resolve import "\.\/gone"/);
  });
});

describe("checkTree", () => {
  it("passes a demo that imports the real rule chain, with a stand-in for every app import", () => {
    expect(checkTree(reader(cleanTree()), [])).toEqual([]);
  });

  it("fails when the rule chain gains an app import the site has no stand-in for", () => {
    const files = cleanTree({
      "src/lib/cjkFormatter/rules/shared.ts": 'import { t } from "@/utils/tableParser";\nexport const a = 1;\n',
    });
    const failures = checkTree(reader(files), []);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("`@/utils/tableParser`");
  });

  it("fails closed when the site config is missing", () => {
    const files = cleanTree();
    delete files[SITE_CONFIG];
    expect(() => checkTree(reader(files), [])).toThrow(/cannot read website\/\.vitepress\/config\/shared\.ts/);
  });

  it("fails when the site config no longer stands in for an import the rule chain needs", () => {
    const failures = checkTree(reader(cleanTree({ [SITE_CONFIG]: "vite: {}" })), []);
    expect(failures).toEqual([expect.stringContaining("does not stand in for `@/utils/debug`")]);
  });

  it("fails when the demo stops importing the app's rule chain", () => {
    const files = cleanTree({ [DEMO_COMPONENT]: "import { applyRules, defaultCJKSettings } from './cjkFormatter'" });
    const failures = checkTree(reader(files), []);
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("`applyRules`");
    expect(failures.join("\n")).toContain("`DEFAULT_CJK_FORMATTING`");
  });

  it("fails on a fork: a website module that defines its own rule chain or settings", () => {
    const failures = checkTree(reader(cleanTree()), [
      ["website/.vitepress/components/demos/cjkFormatter.ts", "export function applyRules(text, config) { return text; }"],
      ["website/.vitepress/components/demos/other.ts", "export const defaultCJKSettings = { a: true };"],
      ["website/.vitepress/components/demos/fine.ts", "export const unrelated = 1;"],
    ]);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("cjkFormatter.ts");
    expect(failures[1]).toContain("other.ts");
  });
});

describe("the pieces, directly", () => {
  it("demoImportFailures accepts double-quoted specifiers too", () => {
    expect(demoImportFailures(DEMO_OK.replaceAll("'", '"'))).toEqual([]);
  });

  it("forkFailures names the declaration it found", () => {
    expect(forkFailures([["w.ts", "const DEFAULT_CJK_FORMATTING = {}"]])[0]).toContain("DEFAULT_CJK_FORMATTING");
  });

  it("a config naming only a prefix of the specifier does not count", () => {
    const prefixOnly = checkTree(reader(cleanTree({ [SITE_CONFIG]: 'const APP = "@/utils/";' })), []);
    expect(prefixOnly).toEqual([expect.stringContaining("does not stand in for `@/utils/debug`")]);
  });

  it("SITE_ALIASES is exactly the specifiers the site config stands in for", () => {
    expect(SITE_ALIASES).toEqual(["@/utils/debug"]);
  });
});

describe("the gate against the real repository", () => {
  it("passes on the tree as committed", () => {
    const out = execFileSync("node", [join(root, "scripts/check-cjk-demo-parity.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(out).toContain("runs the app's formatter");
  });

  it("names the files it reads", () => {
    expect(RULES_ENTRY).toBe("src/lib/cjkFormatter/rules/applyRules.ts");
    expect(DEMO_COMPONENT).toBe("website/.vitepress/components/demos/CJKFormatDemo.vue");
    expect(SITE_CONFIG).toBe("website/.vitepress/config/shared.ts");
  });
});
