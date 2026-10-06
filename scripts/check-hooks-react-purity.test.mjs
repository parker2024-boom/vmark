// WI-RA13A.4 — the hooks-tier purity gate rejects every shape of misfiled business module and never passes on a tree it did not scan
/**
 * Runs the REAL `scripts/check-hooks-react-purity.mjs --root <fixture>` against
 * fixture trees, and drives its exported classifier directly for the shapes
 * that are cheaper to state as a table.
 *
 * The evidence rules under test (a file in `src/hooks/` must show ONE):
 *   1. it imports a react module;
 *   2. it CALLS a hook-named identifier;
 *   3. it re-exports a hook.
 * and the three false-pass classes a text match used to admit: evidence inside
 * a comment, evidence inside a string, and a hook DECLARATION vouching for
 * itself.
 *
 * @coordinates-with scripts/check-hooks-react-purity.mjs — the gate under test
 * @coordinates-with scripts/depcruise-sensitivity.test.mjs — pins this gate beside the dependency rules it complements
 * @module scripts/check-hooks-react-purity.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isReactAdapter, isReactModule, isTestAdjacent, scanHooksTier } from "./check-hooks-react-purity.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-hooks-react-purity.mjs");

const HOOK = 'import { useEffect } from "react";\nexport function useReal() { useEffect(() => {}, []); }\n';
const BUSINESS = "export function compute(n: number): number { return n + 1; }\n";

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "hooks-purity-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function run(root, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], { encoding: "utf8" });
  return { ...r, out: r.stdout + r.stderr };
}

describe("check-hooks-react-purity.mjs — CLI", () => {
  it("exits 0 on a tier of real adapters and says how many files it scanned", () => {
    const r = run(fixture({ "src/hooks/useReal.ts": HOOK, "src/hooks/nested/deep/useAlso.ts": HOOK }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Hooks-tier purity held");
    expect(r.out).toContain("2 files scanned");
  });

  it("exits 1 on a business module and names it, including in a nested directory", () => {
    const r = run(
      fixture({
        "src/hooks/useReal.ts": HOOK,
        "src/hooks/compute.ts": BUSINESS,
        "src/hooks/lifecycle/helpers.ts": BUSINESS,
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("2 non-React business module(s)");
    expect(r.out).toContain("src/hooks/compute.ts");
    expect(r.out).toContain("src/hooks/lifecycle/helpers.ts");
    expect(r.out).not.toContain("src/hooks/useReal.ts");
  });

  it("a file that does not parse is an offender, not a pass", () => {
    const r = run(fixture({ "src/hooks/useReal.ts": HOOK, "src/hooks/broken.ts": "export function ( {\n" }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/hooks/broken.ts (does not parse:");
  });

  it("test-adjacent files are out of scope", () => {
    const r = run(
      fixture({
        "src/hooks/useReal.ts": HOOK,
        "src/hooks/useReal.test.ts": BUSINESS,
        "src/hooks/thing.spec.tsx": BUSINESS,
        "src/hooks/__tests__/helper.ts": BUSINESS,
        "src/hooks/__mocks__/fake.ts": BUSINESS,
        "src/hooks/types.d.ts": "export type T = number;\n",
      }),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("1 files scanned");
  });

  it("only .ts and .tsx are examined", () => {
    const r = run(fixture({ "src/hooks/useReal.ts": HOOK, "src/hooks/notes.md": "compute()", "src/hooks/x.json": "{}" }));
    expect(r.status, r.out).toBe(0);
  });

  it("files outside src/hooks/ are not this gate's business", () => {
    const r = run(fixture({ "src/hooks/useReal.ts": HOOK, "src/services/domain/compute.ts": BUSINESS }));
    expect(r.status, r.out).toBe(0);
  });

  // A gate that scanned nothing has verified nothing. Both of these used to
  // print the success line: the first after a rename of the directory, the
  // second after a glob or filter mistake.
  it("a root with NO src/hooks directory fails", () => {
    const r = run(fixture({ "src/services/a.ts": BUSINESS }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/hooks/ not found");
    expect(r.out).not.toContain("purity held");
  });

  it("a src/hooks directory with nothing to scan fails", () => {
    const r = run(fixture({ "src/hooks/useReal.test.ts": HOOK, "src/hooks/README.md": "x" }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("scanned 0 files");
    expect(r.out).not.toContain("purity held");
  });

  it("an unknown argument fails rather than being ignored", () => {
    const r = run(fixture({ "src/hooks/useReal.ts": HOOK }), ["--fix"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Unknown argument: --fix");
  });

  it("--root with no value fails", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--root"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("purity held");
  });
});

describe("isReactAdapter — what counts as evidence", () => {
  it.each([
    ["a react import", 'import { useState } from "react";\nexport const x = 1;'],
    ["a default react import", 'import React from "react";\nexport const x = 1;'],
    ["a react-dom import", 'import { createPortal } from "react-dom";\nexport const x = createPortal;'],
    ["a react subpath import", 'import { jsx } from "react/jsx-runtime";\nexport const x = jsx;'],
    ["a react-dom subpath import", 'import { createRoot } from "react-dom/client";\nexport const x = createRoot;'],
    ["require of react", 'const React = require("react");\nexport const x = React;'],
    ["import-equals of react", 'import React = require("react");\nexport const x = React;'],
    ["a dynamic import of react", 'export const load = () => import("react");'],
    ["an export-from react", 'export { useMemo } from "react";'],
    ["a hook call with no react import (composite)", 'import { useThing } from "./useThing";\nexport function useBoth() { return useThing(); }'],
    ["a zustand selector call", 'import { useFooStore } from "@/stores/foo";\nexport function useN() { return useFooStore((s) => s.n); }'],
    ["a named hook re-export", 'export { useThing } from "./useThing";'],
    ["a renamed hook re-export", 'export { thing as useThing } from "./thing";'],
    ["a hook re-exported under another name", 'export { useThing as thing } from "./useThing";'],
    ["a namespace re-export named like a hook", 'export * as useKit from "./kit";'],
    ["a star re-export of a hook module", 'export * from "./useThing";'],
    ["a hook call nested in a callback", "export const f = () => { const g = () => useThing(); return g; };\ndeclare function useThing(): void;"],
    ["CJK identifiers and strings beside a real hook call", 'export function use数据() { const 标题 = "标题"; return useThing(标题); }\ndeclare function useThing(s: string): void;'],
  ])("%s -> adapter", (_label, src) => {
    expect(isReactAdapter(src)).toBe(true);
  });

  it.each([
    ["a plain business module", BUSINESS],
    ["an empty file", ""],
    ["a file of only comments", "// nothing here\n/* at all */\n"],
    ["a react import inside a line comment", '// import { useEffect } from "react";\nexport const x = 1;'],
    ["a react import inside a block comment", '/* import React from "react"; */\nexport const x = 1;'],
    ["a hook call inside a string", 'export const doc = "call useState(0) here";'],
    ["a hook call inside a template literal", "export const doc = `useEffect(() => {})`;"],
    ["a react specifier that is only a string value", 'export const dep = "react";'],
    ["a hook DECLARATION vouching for itself", "export function useBusiness() { return 1; }"],
    ["a hook-named arrow declaration", "export const useBusiness = () => 1;"],
    ["the imperative store API", 'import { useFooStore } from "@/stores/foo";\nexport const n = () => useFooStore.getState().n;'],
    ["a method named like a hook", "export const n = (o: { useX(): number }) => o.useX();"],
    ["a lowercase use-prefixed call", "export const n = () => user();\ndeclare function user(): number;"],
    ["`use` alone", "export const n = () => use();\ndeclare function use(): number;"],
    ["a package whose name merely starts with react", 'import x from "react-router";\nexport const y = x;'],
    ["a non-hook re-export", 'export { compute } from "./compute";'],
    ["a star re-export of a non-hook module", 'export * from "./compute";'],
    ["a star re-export whose DIRECTORY is hook-named", 'export * from "./useThing/helpers";'],
  ])("%s -> not an adapter", (_label, src) => {
    expect(isReactAdapter(src)).toBe(false);
  });

  it("parses .tsx as TSX, so JSX is not a syntax error", () => {
    const src = 'import { useState } from "react";\nexport const C = () => { const [n] = useState(0); return <b>{n}</b>; };';
    expect(isReactAdapter(src, "C.tsx")).toBe(true);
    expect(() => isReactAdapter("export const C = () => <b>x</b>;", "C.ts")).toThrow();
  });

  it("throws on a file that does not parse", () => {
    expect(() => isReactAdapter("export function ( {")).toThrow();
  });
});

describe("helpers", () => {
  it.each([
    ["react", true],
    ["react-dom", true],
    ["react/jsx-runtime", true],
    ["react-dom/client", true],
    ["react-router", false],
    ["preact", false],
    ["@types/react", false],
    ["./react", false],
    ["", false],
  ])("isReactModule(%j) is %s", (spec, expected) => {
    expect(isReactModule(spec)).toBe(expected);
  });

  it.each([
    ["src/hooks/useX.test.ts", true],
    ["src/hooks/useX.spec.tsx", true],
    ["src/hooks/types.d.ts", true],
    ["src/hooks/__tests__/h.ts", true],
    ["src/hooks/__mocks__/h.ts", true],
    ["src/hooks/useX.ts", false],
    ["src/hooks/testing.ts", false],
    ["src/hooks/latest/useX.ts", false],
  ])("isTestAdjacent(%j) is %s", (rel, expected) => {
    expect(isTestAdjacent(rel)).toBe(expected);
  });

  it("scanHooksTier returns offenders sorted, with the scanned count", () => {
    const root = fixture({ "src/hooks/z.ts": BUSINESS, "src/hooks/a.ts": BUSINESS, "src/hooks/useReal.ts": HOOK });
    expect(scanHooksTier(root)).toEqual({ offenders: ["src/hooks/a.ts", "src/hooks/z.ts"], scanned: 3 });
  });
});
