// WI-RA17D.6 — two source-layout conventions, checked against the real tree.
//
// 1. Plugin entry points. Rule 50 §3 documents `src/plugins/<name>/index.ts`
//    (ProseMirror factory) and `tiptap.ts` (Tiptap wrapper) as the entries. A
//    directory with neither is a module cluster (helpers, views, registries
//    that other plugins use), and rule 50 §3 must name it — so the documented
//    list and the tree cannot drift apart in either direction.
// 2. Zustand store factories live in `src/stores/`. Elsewhere a module may take
//    a `StoreApi` type (plugins receive their popup store that way), but a
//    production file outside `src/stores/` that CREATES a store is a store in
//    the wrong layer.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = path.join(REPO, "src", "plugins");
const RULE_50 = path.join(REPO, ".claude", "rules", "50-codebase-conventions.md");

/** The `name/` tokens rule 50 §3 lists after "Module clusters". */
function documentedClusters() {
  const rule = readFileSync(RULE_50, "utf8");
  const section = rule.split(/^## /m).find((s) => s.startsWith("3. Plugins"));
  if (!section) throw new Error("rule 50 has no '## 3. Plugins' section");
  const at = section.indexOf("Module clusters");
  if (at < 0) throw new Error("rule 50 §3 has no 'Module clusters' list");
  const paragraph = section.slice(at).split(/\n\s*\n/)[0];
  return [...paragraph.matchAll(/`([A-Za-z0-9_]+)\/`/g)].map((m) => m[1]);
}

function pluginDirs() {
  return readdirSync(PLUGINS).filter(
    (name) => !name.startsWith("__") && statSync(path.join(PLUGINS, name)).isDirectory(),
  );
}

const hasEntry = (dir) =>
  ["index.ts", "tiptap.ts"].some((entry) => existsSync(path.join(PLUGINS, dir, entry)));

/** True when `source` imports a zustand store FACTORY as a value. */
function createsZustandStore(source) {
  for (const m of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']zustand(?:\/vanilla)?["']/g)) {
    if (m[1]) continue;
    const names = m[2].split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type "));
    if (names.some((n) => /^(create|createStore)\b/.test(n))) return true;
  }
  return false;
}

function productionFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "test") productionFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.(test|bench|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("plugin entry convention (rule 50 §3)", () => {
  it("rule 50 §3 names at least one module cluster", () => {
    expect(documentedClusters().length).toBeGreaterThan(0);
  });

  it("every plugin directory has index.ts or tiptap.ts, or is a documented module cluster", () => {
    const clusters = new Set(documentedClusters());
    const deviants = pluginDirs().filter((dir) => !hasEntry(dir) && !clusters.has(dir));
    expect(deviants).toEqual([]);
  });

  it("every documented module cluster is a real plugin directory", () => {
    const dirs = new Set(pluginDirs());
    expect(documentedClusters().filter((name) => !dirs.has(name))).toEqual([]);
  });
});

describe("zustand stores live in src/stores", () => {
  it("recognises a store factory and ignores type-only imports", () => {
    expect(createsZustandStore('import { create } from "zustand";')).toBe(true);
    expect(createsZustandStore("import { createStore, type StoreApi } from 'zustand/vanilla';")).toBe(true);
    expect(createsZustandStore('import type { StoreApi } from "zustand";')).toBe(false);
    expect(createsZustandStore('import { type StoreApi } from "zustand";')).toBe(false);
    expect(createsZustandStore('import { useStore } from "zustand";')).toBe(false);
  });

  it("no production file outside src/stores creates a store", () => {
    const stores = path.join(REPO, "src", "stores") + path.sep;
    const offenders = productionFiles(path.join(REPO, "src"))
      .filter((file) => !file.startsWith(stores) && !file.startsWith(path.join(REPO, "src", "test") + path.sep))
      .filter((file) => createsZustandStore(readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO, file));
    expect(offenders).toEqual([]);
  });
});
