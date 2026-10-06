// @vitest-environment node
// WI-RA1A.2 — architecture-fitness test: the MCP bridge has exactly one way to
// put a document on disk, and it is the app's save pipeline.
//
// Three handlers used to import plugin-fs `writeTextFile` and write for
// themselves. Nothing in the type system stopped them, and their unit tests
// mocked the writer, so the bypass was invisible: an AI client's write lost the
// file's line endings and BOM, was not ordered against other saves, took no
// history snapshot and was not atomic. This test makes the rule structural, so
// the next handler that reaches for a raw write fails here instead of shipping.
//
// What it holds, over every production file under services/mcpBridge:
//   1. no write-capable plugin-fs import (reads and `exists` stay allowed);
//   2. no direct `atomic_write_file` invoke — the pipeline's own write, which
//      would skip normalization, ordering and the saved snapshots just the same;
//   3. the save pipeline is entered from `v2/bridgeSave.ts` only, because that
//      module puts the path guard in front of it on every call.
//
// Limitation: it reads import and call text, so it catches the realistic
// regression (a handler importing a writer) and not a write smuggled through
// some other module. The behaviour itself is pinned by mcpSavePipeline.test.ts.
//
// @coordinates-with services/mcpBridge/v2/bridgeSave.ts — the one door
// @coordinates-with fsGuardInvariant.test.ts — the sibling path-guard invariant

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BRIDGE_ROOT = resolve(import.meta.dirname, "..", "..");
const SAVE_DOOR = join("v2", "bridgeSave.ts");

/** Recursively collect non-test .ts source files under the bridge tree. */
function collectBridgeSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...collectBridgeSources(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

/** Comments name the forbidden APIs to explain the rule; only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The names a file imports from `@tauri-apps/plugin-fs`, across all forms. */
function pluginFsImports(code: string): string[] {
  const names: string[] = [];
  const statement = /import\s+(?:type\s+)?([^;]*?)\s+from\s+["']@tauri-apps\/plugin-fs["']/g;
  for (const match of code.matchAll(statement)) {
    const clause = match[1];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    // `import * as fs` or a default import can reach every export.
    if (/\*\s+as\s+\w+/.test(clause) || /^\w+/.test(clause.trim())) names.push("*");
  }
  if (/import\(\s*["']@tauri-apps\/plugin-fs["']\s*\)/.test(code)) names.push("*");
  return names;
}

/** plugin-fs exports that put or change bytes at a path. */
const WRITE_CAPABLE = new Set([
  "*",
  "writeTextFile",
  "writeFile",
  "create",
  "open",
  "copyFile",
  "truncate",
  "rename",
  "remove",
]);

const sources = collectBridgeSources(BRIDGE_ROOT).map((file) => ({
  file: relative(BRIDGE_ROOT, file),
  code: stripComments(readFileSync(file, "utf8")),
}));

describe("MCP bridge disk-write invariant", () => {
  it("finds bridge source files to scan, including the save door", () => {
    // A scan that found nothing would pass every assertion below vacuously.
    expect(sources.length).toBeGreaterThan(40);
    expect(sources.map((s) => s.file)).toContain(SAVE_DOOR);
  });

  it("recognises every import form it is meant to refuse", () => {
    // The detector is the whole test; prove it sees what it claims to.
    expect(pluginFsImports('import { exists, writeTextFile } from "@tauri-apps/plugin-fs";')).toEqual([
      "exists",
      "writeTextFile",
    ]);
    expect(
      pluginFsImports('import {\n  readTextFile,\n  writeTextFile as write,\n} from "@tauri-apps/plugin-fs";'),
    ).toEqual(["readTextFile", "writeTextFile"]);
    expect(pluginFsImports('import * as fs from "@tauri-apps/plugin-fs";')).toEqual(["*"]);
    expect(pluginFsImports('const fs = await import("@tauri-apps/plugin-fs");')).toEqual(["*"]);
    expect(pluginFsImports('import { exists } from "@tauri-apps/plugin-fs";')).toEqual(["exists"]);
    expect(stripComments("// writeTextFile(a)\n/* atomic_write_file */\nconst x = 1;")).not.toMatch(
      /writeTextFile|atomic_write_file/,
    );
  });

  it("no bridge file imports a write-capable plugin-fs API", () => {
    const offenders = sources.flatMap(({ file, code }) =>
      pluginFsImports(code)
        .filter((name) => WRITE_CAPABLE.has(name))
        .map((name) => `${file} imports ${name === "*" ? "the whole module" : name}`),
    );

    expect(
      offenders,
      "MCP bridge files must not write through @tauri-apps/plugin-fs. Save a " +
        "document with saveTabForBridge (services/mcpBridge/v2/bridgeSave.ts), " +
        "which runs the path guard and the app's save pipeline.",
    ).toEqual([]);
  });

  it("no bridge file invokes atomic_write_file itself", () => {
    const offenders = sources.filter(({ code }) => code.includes("atomic_write_file")).map((s) => s.file);

    expect(
      offenders,
      "atomic_write_file is the save pipeline's own write. Calling it from the " +
        "bridge skips normalization, ordering and the saved snapshots — use " +
        "saveTabForBridge instead.",
    ).toEqual([]);
  });

  it("only bridgeSave.ts enters the save pipeline", () => {
    const pipelineImport = /from\s+["'](?:@\/services\/persistence|\.\.?(?:\/\.\.)*\/persistence)\/saveToPath["']/;
    const offenders = sources
      .filter(({ file, code }) => file !== SAVE_DOOR && pipelineImport.test(code))
      .map((s) => s.file);

    expect(
      offenders,
      "Only services/mcpBridge/v2/bridgeSave.ts may import the save pipeline: " +
        "it is what puts the path guard in front of every bridge write.",
    ).toEqual([]);
    // And the door really does both, in that order of dependence.
    const door = sources.find((s) => s.file === SAVE_DOOR)?.code ?? "";
    expect(door).toContain("saveToPathForMcp");
    expect(door).toContain("checkBridgePath");
  });
});
