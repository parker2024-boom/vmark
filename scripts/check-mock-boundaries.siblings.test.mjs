// WI-RA13B.8 — the mock-boundary gate sees same-feature sibling mocks.
// WI-RA14A.2 — and allows none of them: there is no baseline to list one in.
// WI-RA24.8 — including one spelled with the `@/` alias.
/**
 * A relative `vi.mock("./x")` / `vi.mock("../x")` of a module that is the
 * app's own logic replaces real behaviour with a hand-written fake — the
 * anti-pattern `.claude/rules/10-tdd.md` names. A relative mock of a module
 * that wraps a real boundary (it imports `@tauri-apps/*` or a Node builtin)
 * is the sanctioned pattern and is not counted. Non-code targets (CSS, raw
 * assets) carry no logic and are not counted either.
 *
 * The frozen list of existing sibling mocks reached zero and was deleted, so
 * the rule is absolute: a baseline that tries to list one fails closed.
 *
 * Like the store-mock suite, these run the REAL script against tmpdir
 * fixture trees and assert on the message as well as the exit code.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "check-mock-boundaries.mjs");

function writeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "mock-siblings-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runGate(root, baseline, extra = []) {
  const baselinePath = path.join(root, "baseline.json");
  writeFileSync(baselinePath, typeof baseline === "string" ? baseline : JSON.stringify(baseline, null, 2));
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--baseline", baselinePath, ...extra], {
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", baselinePath };
}

const EMPTY = { entries: [] };
const triple = (file, api, target) => ({ file, api, target });

const LOGIC = `export function add(a, b) { return a + b; }\n`;
const TAURI_WRAPPER = `import { invoke } from "@tauri-apps/api/core";\nexport const load = () => invoke("load");\n`;
const FS_WRAPPER = `import { readFile } from "node:fs/promises";\nexport const read = (p) => readFile(p, "utf8");\n`;

describe("sibling mocks — the subject's own logic", () => {
  it("fails on vi.mock('./sibling') of a logic module, naming file and resolved target", () => {
    const root = writeTree({
      "src/feature/calc.ts": LOGIC,
      "src/feature/calc.test.ts": `import { vi } from "vitest";\nvi.mock("./calc");\n`,
    });
    const { status, stderr } = runGate(root, EMPTY);
    expect(status).toBe(1);
    expect(stderr).toContain("sibling");
    expect(stderr).toContain("src/feature/calc.test.ts");
    expect(stderr).toContain("src/feature/calc");
  });

  it("fails on a parent-relative mock from __tests__/, and on vi.doMock", () => {
    const root = writeTree({
      "src/feature/calc.tsx": LOGIC,
      "src/feature/__tests__/calc.test.ts": `import { vi } from "vitest";\nvi.doMock("../calc");\n`,
    });
    const { status, stderr } = runGate(root, EMPTY);
    expect(status).toBe(1);
    expect(stderr).toContain("src/feature/__tests__/calc.test.ts — vi.doMock → src/feature/calc");
  });

  it("resolves a directory import to its index module", () => {
    const root = writeTree({
      "src/feature/parts/index.ts": LOGIC,
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock("./parts");\n`,
    });
    const { status, stderr } = runGate(root, EMPTY);
    expect(status).toBe(1);
    expect(stderr).toContain("src/feature/parts");
  });

  it("resolves a TS-ESM `.js` specifier to the `.ts` source", () => {
    const root = writeTree({
      "server/x/src/index.ts": LOGIC,
      "server/x/__tests__/unit/a.test.ts": `import { vi } from "vitest";\nvi.mock("../../src/index.js");\n`,
    });
    const { status, stderr } = runGate(root, EMPTY);
    expect(status).toBe(1);
    expect(stderr).toContain("server/x/src/index");
  });

  it("fails closed on a relative code target that does not exist", () => {
    const root = writeTree({
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock("./gone");\n`,
    });
    const { status, stderr } = runGate(root, EMPTY);
    expect(status).toBe(1);
    expect(stderr).toContain("src/feature/gone");
  });

  it("cannot be baselined: a baseline that lists sibling mocks fails closed", () => {
    const root = writeTree({
      "src/feature/calc.ts": LOGIC,
      "src/feature/calc.test.ts": `import { vi } from "vitest";\nvi.mock("./calc");\n`,
    });
    const listed = { entries: [], siblingEntries: [triple("src/feature/calc.test.ts", "vi.mock", "src/feature/calc")] };
    const { status, stderr } = runGate(root, listed);
    expect(status).toBe(1);
    expect(stderr).toContain("siblingEntries");
    expect(stderr).toContain("cannot be baselined");
  });

  it("an empty siblingEntries list fails closed too — the key itself is gone", () => {
    const root = writeTree({ "src/feature/ok.test.ts": `export {};\n` });
    const { status, stderr } = runGate(root, { entries: [], siblingEntries: [] });
    expect(status).toBe(1);
    expect(stderr).toContain("siblingEntries");
  });

  it("--write-baseline refuses while a sibling mock exists, and writes nothing", () => {
    const root = writeTree({
      "src/feature/calc.ts": LOGIC,
      "src/feature/calc.test.ts": `import { vi } from "vitest";\nvi.mock("./calc");\n`,
    });
    const before = JSON.stringify(EMPTY, null, 2);
    const { status, stderr, baselinePath } = runGate(root, EMPTY, ["--write-baseline"]);
    expect(status).toBe(1);
    expect(stderr).toContain("src/feature/calc.test.ts — vi.mock → src/feature/calc");
    expect(readFileSync(baselinePath, "utf8")).toBe(before);
  });

  it("--write-baseline records store mocks only, with no siblingEntries key", () => {
    const root = writeTree({
      "src/stores/fooStore.ts": LOGIC,
      "src/hooks/a.test.ts": `import { vi } from "vitest";\nvi.mock("@/stores/fooStore");\n`,
    });
    const { status, baselinePath } = runGate(root, EMPTY, ["--write-baseline"]);
    expect(status).toBe(0);
    const written = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(written.entries).toEqual([triple("src/hooks/a.test.ts", "vi.mock", "src/stores/fooStore")]);
    expect(Object.keys(written)).not.toContain("siblingEntries");
  });
});

describe("sibling mocks — sanctioned boundaries and non-code", () => {
  it.each([
    ["a Tauri wrapper", TAURI_WRAPPER],
    ["a Node filesystem wrapper", FS_WRAPPER],
    ["a wrapper re-exporting from a Tauri plugin", `export { open } from "@tauri-apps/plugin-dialog";\n`],
    ["a wrapper loading a builtin lazily", `export const sh = () => import("child_process");\n`],
  ])("does not count a relative mock of %s", (_label, source) => {
    const root = writeTree({
      "src/feature/io.ts": source,
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock("./io");\n`,
    });
    const { status, stdout } = runGate(root, EMPTY);
    expect(status).toBe(0);
    expect(stdout).toContain("held");
  });

  it.each(["./styles.css", "./reader.css?raw", "./icon.svg"])("does not count a non-code target %s", (spec) => {
    const root = writeTree({
      "src/feature/styles.css": `.a{}\n`,
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock(${JSON.stringify(spec)});\n`,
    });
    expect(runGate(root, EMPTY).status).toBe(0);
  });

  it("does not double-count a relative mock that resolves into src/stores/", () => {
    const root = writeTree({
      "src/stores/fooStore.ts": LOGIC,
      "src/hooks/a.test.ts": `import { vi } from "vitest";\nvi.mock("../stores/fooStore");\n`,
    });
    const { status, stderr } = runGate(root, {
      entries: [triple("src/hooks/a.test.ts", "vi.mock", "src/stores/fooStore")],
    });
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("ignores bare package specifiers", () => {
    const root = writeTree({
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock("katex");\n`,
    });
    expect(runGate(root, EMPTY).status).toBe(0);
  });
});

// A sibling spelled with the `@/` alias is still a sibling: the relative
// rule must not be dodged by writing the same module another way.
describe("sibling mocks — spelled with the @/ alias", () => {
  it("fails on an alias mock of a logic module in the test's own directory", () => {
    const root = writeTree({
      "src/feature/calc.ts": LOGIC,
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock("@/feature/calc");\n`,
    });
    const { status, stderr } = runGate(root, EMPTY);
    expect(status).toBe(1);
    expect(stderr).toContain("src/feature/a.test.ts");
    expect(stderr).toContain("src/feature/calc");
  });

  it("fails on an alias mock from __tests__/ of a module beside the directory", () => {
    const root = writeTree({
      "src/feature/calc.ts": LOGIC,
      "src/feature/__tests__/a.test.ts": `import { vi } from "vitest";\nvi.doMock("@/feature/calc");\n`,
    });
    expect(runGate(root, EMPTY).status).toBe(1);
  });

  it("does not count an alias mock of a sibling that wraps a boundary", () => {
    const root = writeTree({
      "src/feature/io.ts": TAURI_WRAPPER,
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock("@/feature/io");\n`,
    });
    expect(runGate(root, EMPTY).status).toBe(0);
  });

  it("leaves an alias mock of a module in ANOTHER directory to the wider rule, not this one", () => {
    const root = writeTree({
      "src/other/calc.ts": LOGIC,
      "src/feature/a.test.ts": `import { vi } from "vitest";\nvi.mock("@/other/calc");\n`,
    });
    expect(runGate(root, EMPTY).status).toBe(0);
  });
});
